import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";
import { homedir } from "node:os";

const MODEL_ICON = "";
const MODEL_ICON_GAP = "  ";
const BRANCH_ICON = "";
const BAR_FULL = "█";
const BAR_EMPTY = "░";
const DEFAULT_BAR_WIDTH = 10;
const MIN_BAR_WIDTH = 4;
const BRANCH_SECTION_MAX_WIDTH = 24;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type SeparatorMode = {
	raw: string;
	styled: string;
};

type Line1Section = {
	styled: string;
	width: number;
};

type StatuslineSnapshot = {
	cwd: string;
	modelLabel: string;
	thinking: ThinkingLevel;
	contextPercent: number;
	inputTokens: number;
	outputTokens: number;
};

const thinkingColors: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	const rerender = () => requestRender?.();

	const applyFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const footerRequestRender = () => tui.requestRender();
			requestRender = footerRequestRender;
			const unsubscribe = footerData.onBranchChange(footerRequestRender);

			return {
				dispose() {
					if (requestRender === footerRequestRender) requestRender = undefined;
					unsubscribe();
				},
				invalidate() {},
				render(width: number): string[] {
					const snapshot = createSnapshot(ctx, pi);
					const innerWidth = Math.max(0, width - 2);
					return [
						padFooterLine(renderLine1(innerWidth, snapshot, footerData, theme), width),
						padFooterLine(renderLine2(innerWidth, footerData, theme), width),
					];
				},
			};
		});

		rerender();
	};

	pi.on("session_start", async (_event, ctx) => {
		applyFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		requestRender = undefined;
	});

	pi.on("model_select", async () => {
		rerender();
	});

	pi.on("message_update", async () => {
		rerender();
	});

	pi.on("message_end", async () => {
		rerender();
	});

	pi.on("turn_end", async () => {
		rerender();
	});

	pi.on("session_tree", async () => {
		rerender();
	});

	pi.on("session_compact", async () => {
		rerender();
	});
}

function createSnapshot(ctx: ExtensionContext, pi: ExtensionAPI): StatuslineSnapshot {
	let inputTokens = 0;
	let outputTokens = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		inputTokens += message.usage?.input ?? 0;
		outputTokens += message.usage?.output ?? 0;
	}

	return {
		cwd: ctx.cwd,
		modelLabel: ctx.model?.name ?? ctx.model?.id ?? "no-model",
		thinking: (ctx.model ? pi.getThinkingLevel() : "off") as ThinkingLevel,
		contextPercent: clampPercent(Math.round(ctx.getContextUsage()?.percent ?? 0)),
		inputTokens,
		outputTokens,
	};
}

function renderLine1(
	width: number,
	snapshot: StatuslineSnapshot,
	footerData: ReadonlyFooterDataProvider,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const tokenSection = buildTokenStatsSection(theme, snapshot);
	const tokenWidth = tokenSection.width;
	const gapWidth = width > tokenWidth ? 1 : 0;
	const leftWidth = Math.max(0, width - tokenWidth - gapWidth);

	if (leftWidth === 0) return truncateToWidth(tokenSection.styled, width);

	const left = renderLine1Left(leftWidth, snapshot, footerData, theme);
	const leftVisibleWidth = visibleWidth(left);
	const spaces = " ".repeat(Math.max(gapWidth, width - leftVisibleWidth - tokenWidth));
	const combined = `${left}${spaces}${tokenSection.styled}`;
	return truncateToWidth(combined, width);
}

function renderLine1Left(
	width: number,
	snapshot: StatuslineSnapshot,
	footerData: ReadonlyFooterDataProvider,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const branch = footerData.getGitBranch();
	const cwdVariants = getCwdVariants(snapshot.cwd);
	const separatorModes: SeparatorMode[] = [
		{ raw: " | ", styled: theme.fg("dim", " | ") },
		{ raw: "|", styled: theme.fg("dim", "|") },
	];
	const barWidths = [10, 8, 6, 4].filter((barWidth, index, values) => {
		return barWidth <= DEFAULT_BAR_WIDTH && barWidth >= MIN_BAR_WIDTH && values.indexOf(barWidth) === index;
	});

	for (const separatorMode of separatorModes) {
		for (const includeBranch of branch ? [true, false] : [false]) {
			for (const cwd of cwdVariants) {
				for (const barWidth of barWidths) {
					const contextSection = buildContextSection(theme, snapshot.contextPercent, barWidth);
					const cwdSection = buildCwdSection(theme, cwd);
					const branchSection = includeBranch && branch ? buildBranchSection(theme, branch, width) : undefined;
					const otherSections = [contextSection, cwdSection, branchSection].filter(
						(section): section is Line1Section => Boolean(section),
					);
					const otherWidth = sumSectionWidths(otherSections);
					const separatorWidth = visibleWidth(separatorMode.raw) * (otherSections.length + 1 - 1);
					const availableForModel = width - otherWidth - separatorWidth;
					const minModelWidth = visibleWidth(`${MODEL_ICON}${MODEL_ICON_GAP}• ${snapshot.thinking}`);

					if (availableForModel < minModelWidth) continue;

					const modelSection = buildModelSection(theme, snapshot.modelLabel, snapshot.thinking, availableForModel);
					const sections = [modelSection, ...otherSections];
					const line = joinSections(
						sections.map((section) => section.styled),
						separatorMode.styled,
					);

					if (visibleWidth(line) <= width) return line;
				}
			}
		}
	}

	const fallbackSeparator = theme.fg("dim", "|");
	const fallbackSections = [
		buildModelSection(theme, snapshot.modelLabel, snapshot.thinking, width),
		buildContextSection(theme, snapshot.contextPercent, MIN_BAR_WIDTH),
		buildCwdSection(theme, cwdVariants.at(-1) ?? (basename(snapshot.cwd) || snapshot.cwd)),
	];
	return truncateToWidth(joinSections(fallbackSections.map((section) => section.styled), fallbackSeparator), width);
}

function renderLine2(
	width: number,
	footerData: ReadonlyFooterDataProvider,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const statuses = [...footerData.getExtensionStatuses().values()].filter((status) => status.length > 0);
	if (statuses.length === 0) return "";

	const separator = theme.fg("dim", " | ");
	const ellipsis = theme.fg("dim", " …");
	const join = (items: string[]) => joinSections(items, separator);
	const fullLine = join(statuses);
	if (visibleWidth(fullLine) <= width) return fullLine;

	const shown: string[] = [];
	for (let i = 0; i < statuses.length; i++) {
		const hiddenAfter = statuses.length - (i + 1);
		const suffix = hiddenAfter > 0 ? `${ellipsis} ${theme.fg("dim", `[+${hiddenAfter}]`)}` : "";
		const candidate = join([...shown, statuses[i]!]) + suffix;
		if (visibleWidth(candidate) <= width) {
			shown.push(statuses[i]!);
			continue;
		}

		if (shown.length === 0) {
			const available = Math.max(0, width - visibleWidth(suffix));
			return truncateToWidth(truncateToWidth(statuses[i]!, available) + suffix, width);
		}

		const hiddenCount = statuses.length - shown.length;
		const finalSuffix = hiddenCount > 0 ? `${ellipsis} ${theme.fg("dim", `[+${hiddenCount}]`)}` : "";
		return truncateToWidth(join(shown) + finalSuffix, width);
	}

	return truncateToWidth(join(shown), width);
}

function buildModelSection(
	theme: ExtensionContext["ui"]["theme"],
	modelLabel: string,
	thinking: ThinkingLevel,
	maxWidth: number,
): Line1Section {
	const minimalRaw = `${MODEL_ICON}${MODEL_ICON_GAP}• ${thinking}`;
	const minimalWidth = visibleWidth(minimalRaw);
	if (maxWidth <= minimalWidth) {
		const raw = truncateToWidth(minimalRaw, Math.max(0, maxWidth));
		return { styled: raw, width: visibleWidth(raw) };
	}

	const iconPart = theme.fg("accent", `${MODEL_ICON}${MODEL_ICON_GAP}`);
	const bulletPart = theme.fg("dim", " • ");
	const thinkingPart = theme.fg(thinkingColors[thinking], thinking);
	const fixedWidth = visibleWidth(`${MODEL_ICON}${MODEL_ICON_GAP}`) + visibleWidth(`• ${thinking}`);
	const availableForModel = Math.max(0, maxWidth - fixedWidth);
	const truncatedModel = truncateToWidth(modelLabel, availableForModel);

	if (visibleWidth(truncatedModel) === 0) {
		const styled = iconPart + bulletPart + thinkingPart;
		return { styled, width: visibleWidth(styled) };
	}

	const styled = `${iconPart}${theme.fg("accent", truncatedModel)}${bulletPart}${thinkingPart}`;
	return { styled, width: visibleWidth(styled) };
}

function buildContextSection(
	theme: ExtensionContext["ui"]["theme"],
	percent: number,
	barWidth: number,
): Line1Section {
	const filledRaw = Math.round((percent / 100) * barWidth);
	const filled = percent > 0 && filledRaw === 0 ? 1 : filledRaw;
	const empty = Math.max(0, barWidth - filled);
	const color = getUsageColor(percent);
	const percentText = `${percent}%`;
	const styled = `${theme.fg(color, BAR_FULL.repeat(filled))}${theme.fg("dim", BAR_EMPTY.repeat(empty))} ${theme.fg(color, percentText)}`;
	return { styled, width: barWidth + 1 + visibleWidth(percentText) };
}

function buildCwdSection(theme: ExtensionContext["ui"]["theme"], cwd: string): Line1Section {
	const styled = theme.fg("muted", cwd);
	return { styled, width: visibleWidth(cwd) };
}

function buildBranchSection(theme: ExtensionContext["ui"]["theme"], branch: string, lineWidth: number): Line1Section {
	const maxSectionWidth = Math.max(8, Math.min(BRANCH_SECTION_MAX_WIDTH, Math.floor(lineWidth / 4) || BRANCH_SECTION_MAX_WIDTH));
	const maxBranchWidth = Math.max(1, maxSectionWidth - visibleWidth(`${BRANCH_ICON} `));
	const truncatedBranch = truncateToWidth(branch, maxBranchWidth);
	const styled = `${theme.fg("accent", BRANCH_ICON)} ${theme.fg("muted", truncatedBranch)}`;
	return { styled, width: visibleWidth(`${BRANCH_ICON} ${truncatedBranch}`) };
}

function buildTokenStatsSection(theme: ExtensionContext["ui"]["theme"], snapshot: StatuslineSnapshot): Line1Section {
	const raw = `↑${formatTokenCount(snapshot.inputTokens)} ↓${formatTokenCount(snapshot.outputTokens)}`;
	const styled = `${theme.fg("dim", "↑")}${theme.fg("muted", formatTokenCount(snapshot.inputTokens))} ${theme.fg("dim", "↓")}${theme.fg("muted", formatTokenCount(snapshot.outputTokens))}`;
	return { styled, width: visibleWidth(raw) };
}

function getCwdVariants(cwd: string): string[] {
	const formatted = formatCwd(cwd);
	const middle = middleElidePath(formatted);
	const base = getBasenameVariant(formatted);
	return [...new Set([formatted, middle, base].filter((value) => value.length > 0))];
}

function formatCwd(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function middleElidePath(cwd: string): string {
	if (cwd === "~" || cwd === "/") return cwd;
	const prefix = cwd.startsWith("~/") ? "~/" : cwd.startsWith("/") ? "/" : "";
	const body = prefix ? cwd.slice(prefix.length) : cwd;
	const parts = body.split("/").filter(Boolean);
	if (parts.length <= 2) return cwd;
	return `${prefix}…/${parts.slice(-2).join("/")}`;
}

function getBasenameVariant(cwd: string): string {
	if (cwd === "~" || cwd === "/") return cwd;
	const raw = basename(cwd);
	return raw.length > 0 ? raw : cwd;
}

function formatTokenCount(value: number): string {
	if (value < 1000) return `${value}`;
	return `${(value / 1000).toFixed(1)}k`;
}

function getUsageColor(percent: number): ThemeColor {
	if (percent < 50) return "success";
	if (percent < 80) return "warning";
	return "error";
}

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

function joinSections(sections: string[], separator: string): string {
	return sections.join(separator);
}

function sumSectionWidths(sections: Line1Section[]): number {
	return sections.reduce((sum, section) => sum + section.width, 0);
}

function padFooterLine(line: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return " ";
	return truncateToWidth(` ${line} `, width);
}

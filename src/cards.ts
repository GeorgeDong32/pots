/**
 * Feishu approval card built with the Chat SDK's jsx-runtime factory — no
 * .tsx: the daemon runs TS sources directly (Node cannot load JSX files),
 * so the card is assembled with explicit `jsxs(...)` calls instead.
 */
import { Actions, Button, Card, CardText } from "chat";
import { jsxs } from "chat/jsx-runtime";
import type { ApprovalCardData } from "./approvals.ts";

/** The M5 approval card: Approve (once) / Always (session 4h) / Deny (P1-3.4). */
export function buildApprovalCard(data: ApprovalCardData) {
	const deadline = new Date(data.deadlineAt).toLocaleTimeString("zh-CN", { hour12: false });
	return jsxs(Card, {
		title: `🔐 工具审批：${data.toolName}`,
		children: [
			jsxs(CardText, {
				children: [
					`参数摘要：${data.argsPreview || "(无)"}`,
					`超时：${deadline}（10 分钟未决自动拒绝）；等待期间本频道消息将排队。`,
				],
			}),
			jsxs(Actions, {
				children: [
					jsxs(Button, { id: "approve_once", value: data.approvalId, style: "primary", children: ["批准（本次）"] }),
					jsxs(Button, { id: "approve_session", value: data.approvalId, children: ["Always（本会话 4h）"] }),
					jsxs(Button, { id: "deny", value: data.approvalId, style: "danger", children: ["拒绝"] }),
				],
			}),
		],
	});
}

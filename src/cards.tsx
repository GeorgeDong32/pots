/** Feishu card construction (Chat SDK JSX). Kept out of channel.ts so the channel module stays plain TS. */
import { Actions, Button, Card, CardText } from "chat";
import type { ApprovalCardData } from "./approvals.js";

/** The M5 approval card: Approve (once) / Always (session 4h) / Deny (P1-3.4). */
export function buildApprovalCard(data: ApprovalCardData) {
	const deadline = new Date(data.deadlineAt).toLocaleTimeString("zh-CN", { hour12: false });
	return (
		<Card title={`🔐 工具审批：${data.toolName}`}>
			<CardText>{`参数摘要：${data.argsPreview || "(无)"}`}</CardText>
			<CardText>{`超时：${deadline}（10 分钟未决自动拒绝）`}</CardText>
			<CardText>⏳ 等待期间本频道消息将排队。</CardText>
			<Actions>
				<Button id="approve_once" value={data.approvalId} style="primary">
					批准（本次）
				</Button>
				<Button id="approve_session" value={data.approvalId}>
					Always（本会话 4h）
				</Button>
				<Button id="deny" value={data.approvalId} style="danger">
					拒绝
				</Button>
			</Actions>
		</Card>
	);
}

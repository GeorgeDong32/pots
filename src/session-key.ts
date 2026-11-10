/** Interactive session address. A missing thread is the channel root, not a shared bucket. */
export function sessionKey(chatId: string, threadId?: string): string {
	return threadId ? `${chatId}\n${threadId}` : chatId;
}

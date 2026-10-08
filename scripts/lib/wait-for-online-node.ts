export type OnlineNode = { nodeId: string; online: boolean };

export async function waitForOnlineNode(
  nodeId: string,
  listNodes: () => Promise<OnlineNode[]>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const now = options.now ?? (() => performance.now());
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const nodes = await listNodes();
    if (nodes.some(node => node.nodeId === nodeId && node.online)) return;
    const remaining = deadline - now();
    if (remaining > 0) await delay(Math.min(intervalMs, remaining));
  }
  throw new Error('target_node_offline');
}

export type OnlineNode = { nodeId: string; online: boolean };

export async function waitForOnlineNode(
  nodeId: string,
  listNodes: () => Promise<OnlineNode[]>,
  options: { attempts?: number; intervalMs?: number; delay?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const attempts = options.attempts ?? 90;
  const intervalMs = options.intervalMs ?? 1_000;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nodes = await listNodes();
    if (nodes.some(node => node.nodeId === nodeId && node.online)) return;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw new Error('target_node_offline');
}

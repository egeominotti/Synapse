interface QueueItem<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  task: () => Promise<T>;
}

export class ChatQueue {
  private queues = new Map<number, QueueItem<unknown>[]>();
  private processing = new Set<number>();
  private maxConcurrent: number;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  async enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.queues.has(chatId)) {
        this.queues.set(chatId, []);
      }
      this.queues.get(chatId)!.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        task,
      });
      this.processNext(chatId);
    });
  }

  private async processNext(chatId: number): Promise<void> {
    if (this.processing.has(chatId)) return;

    const queue = this.queues.get(chatId);
    if (!queue || queue.length === 0) return;

    this.processing.add(chatId);
    const item = queue.shift()!;

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      this.processing.delete(chatId);
      this.processNext(chatId);
    }
  }

  getPendingCount(chatId: number): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  isProcessing(chatId: number): boolean {
    return this.processing.has(chatId);
  }
}

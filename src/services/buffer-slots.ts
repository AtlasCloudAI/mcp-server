/**
 * 把整个文件读进内存的操作（普通上传中转、对话附件导入）同时最多跑几个。
 *
 * 一次 32MB 的上传在内存里至少两份（收到的 Buffer + 转投时的 Blob），pod 上限 512Mi：
 * 不限并发的话，一个登录用户拿一张票同时传十来个大文件就能把 pod 打到 OOM，所有人一起断
 * （11-16 review）。按请求数的限流挡不住这个，要限同时在跑的个数。
 *
 * 排不上的先等（还没读请求体，等着不占内存），等太久才放弃。
 */
const DEFAULT_SLOTS = 3;

function configuredSlots(): number {
  const value = Number(process.env.MCP_BUFFERED_UPLOAD_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SLOTS;
}

let slots = configuredSlots();
let active = 0;
const waiting: Array<() => void> = [];

/** 测试用：改并发数并清空排队。 */
export function resetBufferSlotsForTest(count = configuredSlots()): void {
  slots = count;
  active = 0;
  waiting.length = 0;
}

/** 拿一个名额。拿到返回释放函数（多次调用只算一次）；等了 waitMs 还没轮到返回 undefined。 */
export function acquireBufferSlot(waitMs: number): Promise<(() => void) | undefined> {
  const grant = (): (() => void) => {
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      waiting.shift()?.();
    };
  };
  if (active < slots) return Promise.resolve(grant());
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(grant());
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(wake);
      if (index >= 0) waiting.splice(index, 1);
      resolve(undefined);
    }, waitMs);
    waiting.push(wake);
  });
}

export class BufferSlotsBusyError extends Error {
  constructor() {
    super("Too many uploads are being processed right now. Try again in a minute.");
    this.name = "BufferSlotsBusyError";
  }
}

/** 占着一个名额跑 operation，跑完（成功或失败）就还。排不上抛 BufferSlotsBusyError。 */
export async function withBufferSlot<T>(operation: () => Promise<T>, waitMs = 60_000): Promise<T> {
  const release = await acquireBufferSlot(waitMs);
  if (!release) throw new BufferSlotsBusyError();
  try {
    return await operation();
  } finally {
    release();
  }
}

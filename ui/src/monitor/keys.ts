export const MONITOR_LIST_KEY = ["monitor-boards"] as const;
export const monitorKey = (id: string) => ["monitor-board", id] as const;

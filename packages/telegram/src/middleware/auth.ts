import type { Context, NextFunction } from "grammy";

export function authMiddleware(allowedUsers: number[], allowedGroups: number[]) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId) return; // ignore messages without user

    // Check user whitelist
    if (allowedUsers.length > 0 && allowedUsers.includes(userId)) {
      return next();
    }

    // Check group whitelist
    if (chatId && allowedGroups.length > 0 && allowedGroups.includes(chatId)) {
      return next();
    }

    // If no whitelist configured, allow all (dev mode)
    if (allowedUsers.length === 0 && allowedGroups.length === 0) {
      return next();
    }

    // Silent reject - don't respond to unauthorized users
  };
}

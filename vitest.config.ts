import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "bench/**/*.test.ts"],
    // Worktrees live under .claude/worktrees; never run another branch's tests from main.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "python/**"],
  },
});

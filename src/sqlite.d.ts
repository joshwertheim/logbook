declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class StatementSync {
    run(...anonymousParameters: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...anonymousParameters: unknown[]): unknown;
    all(...anonymousParameters: unknown[]): unknown[];
  }
}

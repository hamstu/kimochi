/** DEV-ONLY stand-in for `@tauri-apps/plugin-shell`: `open` logs instead of launching anything. */
export async function open(path: string, openWith?: string): Promise<void> {
  console.info('[preview] shell.open', path, openWith ?? '')
}

export class Command {
  static create(program: string, args?: string[]): Command {
    return new Command(program, args)
  }
  constructor(
    readonly program: string,
    readonly args?: string[]
  ) {}
  async execute(): Promise<{ code: number; stdout: string; stderr: string; signal: null }> {
    console.info('[preview] shell.Command.execute', this.program, this.args ?? [])
    return { code: 0, stdout: '', stderr: '', signal: null }
  }
}

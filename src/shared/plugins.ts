export interface AppPlugin {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
}

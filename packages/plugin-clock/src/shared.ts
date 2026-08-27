export interface ClockWebData {
  timezone: string;
  lastTime: string;
  refresh(): Promise<string>;
}

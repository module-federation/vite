import { UserConfig } from 'vite';
export interface Command {
    command: string;
}
declare const _default: {
    name: string;
    config: (config: UserConfig, { command }: Command) => void;
};
export default _default;

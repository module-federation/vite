import { UserConfig } from 'vite';
export interface Command {
}
declare const _default: {
    name: string;
    config: (config: UserConfig, { command }: {
        command: Command;
    }) => void;
};
export default _default;

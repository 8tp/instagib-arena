// Side-effect loader for the custom gun models. custom/index.ts (owned by the
// model track) registers every build; it may not exist yet, so it is pulled in
// with a glob (an absent file is simply an empty match). Import this from any
// module that calls customGun().
import.meta.glob('./index.ts', { eager: true });
export {};

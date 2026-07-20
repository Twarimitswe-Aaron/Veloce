
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SVELTEKIT_FORK: string;
	export const NODE_ENV: string;
	export const INIT_CWD: string;
	export const PNPM_SCRIPT_SRC_DIR: string;
	export const XDG_DATA_DIRS: string;
	export const DBUS_STARTER_ADDRESS: string;
	export const ZDOTDIR: string;
	export const npm_execpath: string;
	export const QT_IM_MODULE: string;
	export const LESS_TERMCAP_mb: string;
	export const GDMSESSION: string;
	export const QT_ACCESSIBILITY: string;
	export const NODE_PATH: string;
	export const npm_lifecycle_event: string;
	export const npm_package_version: string;
	export const VTE_VERSION: string;
	export const SSH_AUTH_SOCK: string;
	export const npm_lifecycle_script: string;
	export const TERM_PROGRAM: string;
	export const VSCODE_GIT_IPC_HANDLE: string;
	export const LS_COLORS: string;
	export const XAUTHORITY: string;
	export const XDG_SESSION_DESKTOP: string;
	export const COLORTERM: string;
	export const npm_config_user_agent: string;
	export const OLDPWD: string;
	export const SYSTEMD_EXEC_PID: string;
	export const DESKTOP_SESSION: string;
	export const BUN_INSTALL: string;
	export const TERM_PROGRAM_VERSION: string;
	export const CHROME_DESKTOP: string;
	export const VSCODE_GIT_ASKPASS_NODE: string;
	export const ANTIGRAVITY_CLI_ALIAS: string;
	export const GNOME_TERMINAL_SERVICE: string;
	export const XDG_SESSION_CLASS: string;
	export const GIT_ASKPASS: string;
	export const LESS_TERMCAP_me: string;
	export const VSCODE_INJECTION: string;
	export const POWERSHELL_TELEMETRY_OPTOUT: string;
	export const HOME: string;
	export const TERM: string;
	export const LESS_TERMCAP_ue: string;
	export const WAYLAND_DISPLAY: string;
	export const DOTNET_CLI_TELEMETRY_OPTOUT: string;
	export const NODE: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
	export const XMODIFIERS: string;
	export const XDG_SESSION_TYPE: string;
	export const npm_node_execpath: string;
	export const LESS_TERMCAP_md: string;
	export const COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
	export const SHLVL: string;
	export const PWD: string;
	export const VSCODE_GIT_ASKPASS_MAIN: string;
	export const LESS_TERMCAP_so: string;
	export const LESS_TERMCAP_se: string;
	export const XDG_RUNTIME_DIR: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const npm_package_json: string;
	export const pnpm_config_verify_deps_before_run: string;
	export const USER: string;
	export const npm_command: string;
	export const GPG_AGENT_INFO: string;
	export const LOGNAME: string;
	export const LESS_TERMCAP_us: string;
	export const MANAGERPIDFDID: string;
	export const DISPLAY: string;
	export const QT_AUTO_SCREEN_SCALE_FACTOR: string;
	export const USER_ZDOTDIR: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const DBUS_STARTER_BUS_TYPE: string;
	export const VSCODE_PYTHON_AUTOACTIVATE_GUARD: string;
	export const USERNAME: string;
	export const GNOME_DESKTOP_SESSION_ID: string;
	export const SHELL: string;
	export const npm_config_node_gyp: string;
	export const POWERSHELL_UPDATECHECK: string;
	export const FC_FONTATIONS: string;
	export const PATH: string;
	export const SESSION_MANAGER: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const GDM_LANG: string;
	export const XDG_MENU_PREFIX: string;
	export const npm_package_name: string;
	export const GNOME_TERMINAL_SCREEN: string;
	export const GNOME_SETUP_DISPLAY: string;
	export const _: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const GDK_BACKEND: string;
	export const LANG: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SVELTEKIT_FORK: string;
		NODE_ENV: string;
		INIT_CWD: string;
		PNPM_SCRIPT_SRC_DIR: string;
		XDG_DATA_DIRS: string;
		DBUS_STARTER_ADDRESS: string;
		ZDOTDIR: string;
		npm_execpath: string;
		QT_IM_MODULE: string;
		LESS_TERMCAP_mb: string;
		GDMSESSION: string;
		QT_ACCESSIBILITY: string;
		NODE_PATH: string;
		npm_lifecycle_event: string;
		npm_package_version: string;
		VTE_VERSION: string;
		SSH_AUTH_SOCK: string;
		npm_lifecycle_script: string;
		TERM_PROGRAM: string;
		VSCODE_GIT_IPC_HANDLE: string;
		LS_COLORS: string;
		XAUTHORITY: string;
		XDG_SESSION_DESKTOP: string;
		COLORTERM: string;
		npm_config_user_agent: string;
		OLDPWD: string;
		SYSTEMD_EXEC_PID: string;
		DESKTOP_SESSION: string;
		BUN_INSTALL: string;
		TERM_PROGRAM_VERSION: string;
		CHROME_DESKTOP: string;
		VSCODE_GIT_ASKPASS_NODE: string;
		ANTIGRAVITY_CLI_ALIAS: string;
		GNOME_TERMINAL_SERVICE: string;
		XDG_SESSION_CLASS: string;
		GIT_ASKPASS: string;
		LESS_TERMCAP_me: string;
		VSCODE_INJECTION: string;
		POWERSHELL_TELEMETRY_OPTOUT: string;
		HOME: string;
		TERM: string;
		LESS_TERMCAP_ue: string;
		WAYLAND_DISPLAY: string;
		DOTNET_CLI_TELEMETRY_OPTOUT: string;
		NODE: string;
		MEMORY_PRESSURE_WATCH: string;
		VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
		XMODIFIERS: string;
		XDG_SESSION_TYPE: string;
		npm_node_execpath: string;
		LESS_TERMCAP_md: string;
		COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
		SHLVL: string;
		PWD: string;
		VSCODE_GIT_ASKPASS_MAIN: string;
		LESS_TERMCAP_so: string;
		LESS_TERMCAP_se: string;
		XDG_RUNTIME_DIR: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		npm_package_json: string;
		pnpm_config_verify_deps_before_run: string;
		USER: string;
		npm_command: string;
		GPG_AGENT_INFO: string;
		LOGNAME: string;
		LESS_TERMCAP_us: string;
		MANAGERPIDFDID: string;
		DISPLAY: string;
		QT_AUTO_SCREEN_SCALE_FACTOR: string;
		USER_ZDOTDIR: string;
		MEMORY_PRESSURE_WRITE: string;
		DBUS_STARTER_BUS_TYPE: string;
		VSCODE_PYTHON_AUTOACTIVATE_GUARD: string;
		USERNAME: string;
		GNOME_DESKTOP_SESSION_ID: string;
		SHELL: string;
		npm_config_node_gyp: string;
		POWERSHELL_UPDATECHECK: string;
		FC_FONTATIONS: string;
		PATH: string;
		SESSION_MANAGER: string;
		QT_QPA_PLATFORMTHEME: string;
		GDM_LANG: string;
		XDG_MENU_PREFIX: string;
		npm_package_name: string;
		GNOME_TERMINAL_SCREEN: string;
		GNOME_SETUP_DISPLAY: string;
		_: string;
		XDG_CURRENT_DESKTOP: string;
		GDK_BACKEND: string;
		LANG: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}

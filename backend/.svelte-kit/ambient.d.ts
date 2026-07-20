
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
	export const VELOCE_ALLOWED_EXTENSION_IDS: string;
	export const VELOCE_BASE_DIR: string;
	export const VELOCE_BLOCK_PRIVATE_HOSTS: string;
	export const VELOCE_DEFAULT_THREADS: string;
	export const VELOCE_ENGINE_AUTO_TUNE: string;
	export const VELOCE_ENGINE_QUIET: string;
	export const VELOCE_ENGINE_READ_BUFFER_BYTES: string;
	export const VELOCE_MAX_CONCURRENT_DOWNLOADS: string;
	export const VELOCE_MAX_RATE_BYTES: string;
	export const VELOCE_MIN_FREE_DISK_MB: string;
	export const VELOCE_PORT: string;
	export const LESS_TERMCAP_se: string;
	export const POWERSHELL_TELEMETRY_OPTOUT: string;
	export const USER: string;
	export const LESS_TERMCAP_ue: string;
	export const npm_config_user_agent: string;
	export const DOTNET_CLI_TELEMETRY_OPTOUT: string;
	export const XDG_SESSION_TYPE: string;
	export const BUN_INSTALL: string;
	export const GIT_ASKPASS: string;
	export const npm_node_execpath: string;
	export const SHLVL: string;
	export const OLDPWD: string;
	export const HOME: string;
	export const CHROME_DESKTOP: string;
	export const ANTIGRAVITY_CLI_ALIAS: string;
	export const DESKTOP_SESSION: string;
	export const TERM_PROGRAM_VERSION: string;
	export const npm_package_json: string;
	export const VSCODE_GIT_ASKPASS_MAIN: string;
	export const LESS_TERMCAP_so: string;
	export const VSCODE_GIT_ASKPASS_NODE: string;
	export const SYSTEMD_EXEC_PID: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const DBUS_STARTER_BUS_TYPE: string;
	export const VSCODE_PYTHON_AUTOACTIVATE_GUARD: string;
	export const COLORTERM: string;
	export const COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
	export const WAYLAND_DISPLAY: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const LOGNAME: string;
	export const pnpm_config_verify_deps_before_run: string;
	export const _: string;
	export const QT_AUTO_SCREEN_SCALE_FACTOR: string;
	export const MANAGERPIDFDID: string;
	export const LESS_TERMCAP_us: string;
	export const XDG_SESSION_CLASS: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const USER_ZDOTDIR: string;
	export const USERNAME: string;
	export const TERM: string;
	export const GNOME_DESKTOP_SESSION_ID: string;
	export const FC_FONTATIONS: string;
	export const npm_config_node_gyp: string;
	export const PATH: string;
	export const SESSION_MANAGER: string;
	export const GDM_LANG: string;
	export const npm_package_name: string;
	export const NODE: string;
	export const GNOME_TERMINAL_SCREEN: string;
	export const XDG_MENU_PREFIX: string;
	export const GNOME_SETUP_DISPLAY: string;
	export const XDG_RUNTIME_DIR: string;
	export const GDK_BACKEND: string;
	export const DISPLAY: string;
	export const LANG: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const POWERSHELL_UPDATECHECK: string;
	export const VSCODE_INJECTION: string;
	export const XDG_SESSION_DESKTOP: string;
	export const GNOME_TERMINAL_SERVICE: string;
	export const XMODIFIERS: string;
	export const XAUTHORITY: string;
	export const LS_COLORS: string;
	export const TERM_PROGRAM: string;
	export const VSCODE_GIT_IPC_HANDLE: string;
	export const npm_lifecycle_script: string;
	export const SSH_AUTH_SOCK: string;
	export const SHELL: string;
	export const npm_package_version: string;
	export const npm_lifecycle_event: string;
	export const NODE_PATH: string;
	export const QT_ACCESSIBILITY: string;
	export const GDMSESSION: string;
	export const LESS_TERMCAP_mb: string;
	export const GPG_AGENT_INFO: string;
	export const QT_IM_MODULE: string;
	export const LESS_TERMCAP_md: string;
	export const VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
	export const PWD: string;
	export const LESS_TERMCAP_me: string;
	export const npm_execpath: string;
	export const XDG_DATA_DIRS: string;
	export const DBUS_STARTER_ADDRESS: string;
	export const ZDOTDIR: string;
	export const npm_command: string;
	export const PNPM_SCRIPT_SRC_DIR: string;
	export const VTE_VERSION: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const INIT_CWD: string;
	export const NODE_ENV: string;
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
		VELOCE_ALLOWED_EXTENSION_IDS: string;
		VELOCE_BASE_DIR: string;
		VELOCE_BLOCK_PRIVATE_HOSTS: string;
		VELOCE_DEFAULT_THREADS: string;
		VELOCE_ENGINE_AUTO_TUNE: string;
		VELOCE_ENGINE_QUIET: string;
		VELOCE_ENGINE_READ_BUFFER_BYTES: string;
		VELOCE_MAX_CONCURRENT_DOWNLOADS: string;
		VELOCE_MAX_RATE_BYTES: string;
		VELOCE_MIN_FREE_DISK_MB: string;
		VELOCE_PORT: string;
		LESS_TERMCAP_se: string;
		POWERSHELL_TELEMETRY_OPTOUT: string;
		USER: string;
		LESS_TERMCAP_ue: string;
		npm_config_user_agent: string;
		DOTNET_CLI_TELEMETRY_OPTOUT: string;
		XDG_SESSION_TYPE: string;
		BUN_INSTALL: string;
		GIT_ASKPASS: string;
		npm_node_execpath: string;
		SHLVL: string;
		OLDPWD: string;
		HOME: string;
		CHROME_DESKTOP: string;
		ANTIGRAVITY_CLI_ALIAS: string;
		DESKTOP_SESSION: string;
		TERM_PROGRAM_VERSION: string;
		npm_package_json: string;
		VSCODE_GIT_ASKPASS_MAIN: string;
		LESS_TERMCAP_so: string;
		VSCODE_GIT_ASKPASS_NODE: string;
		SYSTEMD_EXEC_PID: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		DBUS_STARTER_BUS_TYPE: string;
		VSCODE_PYTHON_AUTOACTIVATE_GUARD: string;
		COLORTERM: string;
		COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
		WAYLAND_DISPLAY: string;
		QT_QPA_PLATFORMTHEME: string;
		LOGNAME: string;
		pnpm_config_verify_deps_before_run: string;
		_: string;
		QT_AUTO_SCREEN_SCALE_FACTOR: string;
		MANAGERPIDFDID: string;
		LESS_TERMCAP_us: string;
		XDG_SESSION_CLASS: string;
		MEMORY_PRESSURE_WATCH: string;
		USER_ZDOTDIR: string;
		USERNAME: string;
		TERM: string;
		GNOME_DESKTOP_SESSION_ID: string;
		FC_FONTATIONS: string;
		npm_config_node_gyp: string;
		PATH: string;
		SESSION_MANAGER: string;
		GDM_LANG: string;
		npm_package_name: string;
		NODE: string;
		GNOME_TERMINAL_SCREEN: string;
		XDG_MENU_PREFIX: string;
		GNOME_SETUP_DISPLAY: string;
		XDG_RUNTIME_DIR: string;
		GDK_BACKEND: string;
		DISPLAY: string;
		LANG: string;
		XDG_CURRENT_DESKTOP: string;
		POWERSHELL_UPDATECHECK: string;
		VSCODE_INJECTION: string;
		XDG_SESSION_DESKTOP: string;
		GNOME_TERMINAL_SERVICE: string;
		XMODIFIERS: string;
		XAUTHORITY: string;
		LS_COLORS: string;
		TERM_PROGRAM: string;
		VSCODE_GIT_IPC_HANDLE: string;
		npm_lifecycle_script: string;
		SSH_AUTH_SOCK: string;
		SHELL: string;
		npm_package_version: string;
		npm_lifecycle_event: string;
		NODE_PATH: string;
		QT_ACCESSIBILITY: string;
		GDMSESSION: string;
		LESS_TERMCAP_mb: string;
		GPG_AGENT_INFO: string;
		QT_IM_MODULE: string;
		LESS_TERMCAP_md: string;
		VSCODE_GIT_ASKPASS_EXTRA_ARGS: string;
		PWD: string;
		LESS_TERMCAP_me: string;
		npm_execpath: string;
		XDG_DATA_DIRS: string;
		DBUS_STARTER_ADDRESS: string;
		ZDOTDIR: string;
		npm_command: string;
		PNPM_SCRIPT_SRC_DIR: string;
		VTE_VERSION: string;
		MEMORY_PRESSURE_WRITE: string;
		INIT_CWD: string;
		NODE_ENV: string;
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


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
	export const GTK_THEME: string;
	export const _ZO_DOCTOR: string;
	export const GEM_SPEC_CACHE: string;
	export const PNPM_SCRIPT_SRC_DIR: string;
	export const npm_command: string;
	export const npm_config__jsr_registry: string;
	export const GIT_HTTPS_PROXY: string;
	export const HTTP_PROXY: string;
	export const CURSOR_ORIG_GID: string;
	export const XDG_DATA_DIRS: string;
	export const npm_execpath: string;
	export const PWD: string;
	export const VSCODE_PID: string;
	export const npm_config_globalconfig: string;
	export const socks5_proxy: string;
	export const QT_IM_MODULE: string;
	export const GPG_AGENT_INFO: string;
	export const GJS_DEBUG_OUTPUT: string;
	export const GIT_HTTP_PROXY: string;
	export const __CURSOR_SANDBOX_ENV_RESTORE: string;
	export const DOCKER_HOST: string;
	export const npm_package_json: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const no_proxy: string;
	export const VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
	export const ELECTRON_RUN_AS_NODE: string;
	export const PAGER: string;
	export const https_proxy: string;
	export const ZSH: string;
	export const IM_CONFIG_ENTRY: string;
	export const CURSOR_WORKSPACE_LABEL: string;
	export const GIO_LAUNCHED_DESKTOP_FILE: string;
	export const DOTNET_CLI_TELEMETRY_OPTOUT: string;
	export const WAYLAND_DISPLAY: string;
	export const VSCODE_IPC_HOOK: string;
	export const DISPLAY: string;
	export const LESS: string;
	export const COMPOSER_HOME: string;
	export const STARSHIP_SHELL: string;
	export const CONDA_PKGS_DIRS: string;
	export const NPM_CONFIG_CACHE: string;
	export const ALL_PROXY: string;
	export const CURSOR_RIPGREP_PATH: string;
	export const SYSTEMD_EXEC_PID: string;
	export const LSCOLORS: string;
	export const GNOME_DESKTOP_SESSION_ID: string;
	export const VSCODE_NLS_CONFIG: string;
	export const HTTPS_PROXY: string;
	export const PATH: string;
	export const MANAGERPID: string;
	export const CURSOR_SANDBOX: string;
	export const SOCKS_PROXY: string;
	export const BUN_INSTALL_CACHE_DIR: string;
	export const npm_config_frozen_lockfile: string;
	export const npm_lifecycle_script: string;
	export const USER: string;
	export const CURSOR_ORIG_UID: string;
	export const npm_config_engine_strict: string;
	export const PUPPETEER_CACHE_DIR: string;
	export const COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
	export const SHLVL: string;
	export const npm_config_registry: string;
	export const FORCE_COLOR: string;
	export const NODE_PATH: string;
	export const VSCODE_CWD: string;
	export const CARGO_TARGET_DIR: string;
	export const NO_COLOR: string;
	export const npm_config_devdir: string;
	export const INVOCATION_ID: string;
	export const GIO_LAUNCHED_DESKTOP_FILE_PID: string;
	export const NUGET_PACKAGES: string;
	export const QT_QPA_PLATFORMTHEME: string;
	export const GDM_LANG: string;
	export const VSCODE_ESM_ENTRYPOINT: string;
	export const POWERSHELL_TELEMETRY_OPTOUT: string;
	export const npm_config_user_agent: string;
	export const OLDPWD: string;
	export const VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
	export const CCACHE_DIR: string;
	export const CURSOR_EXTENSION_HOST_ROLE: string;
	export const all_proxy: string;
	export const DESKTOP_SESSION: string;
	export const BUN_INSTALL: string;
	export const CURSOR_SANDBOX_LANDLOCK_STATUS: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const CURSOR_AGENT: string;
	export const XDG_SESSION_TYPE: string;
	export const TMPDIR: string;
	export const npm_node_execpath: string;
	export const HOMEBREW_CACHE: string;
	export const CURSOR_LAYOUT: string;
	export const SSH_AUTH_SOCK: string;
	export const CHROME_DESKTOP: string;
	export const NMAP_PRIVILEGED: string;
	export const HOME: string;
	export const pnpm_config_verify_deps_before_run: string;
	export const CP_HOME_DIR: string;
	export const ELECTRON_USE_GTK: string;
	export const JOURNAL_STREAM: string;
	export const MANAGERPIDFDID: string;
	export const QT_AUTO_SCREEN_SCALE_FACTOR: string;
	export const _: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const INIT_CWD: string;
	export const GJS_DEBUG_TOPICS: string;
	export const http_proxy: string;
	export const GTK2_RC_FILES: string;
	export const XDG_SESSION_CLASS: string;
	export const GOMODCACHE: string;
	export const POETRY_CACHE_DIR: string;
	export const USERNAME: string;
	export const VSCODE_PROCESS_TITLE: string;
	export const socks_proxy: string;
	export const CYPRESS_CACHE_FOLDER: string;
	export const FC_FONTATIONS: string;
	export const NO_PROXY: string;
	export const SOCKS5_PROXY: string;
	export const npm_config_node_gyp: string;
	export const LOGNAME: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const SHELL: string;
	export const YARN_CACHE_FOLDER: string;
	export const CURSOR_CONVERSATION_ID: string;
	export const npm_package_name: string;
	export const XDG_MENU_PREFIX: string;
	export const npm_config_cache: string;
	export const TERM: string;
	export const NODE: string;
	export const GDK_BACKEND: string;
	export const VSCODE_CODE_CACHE_PATH: string;
	export const GOCACHE: string;
	export const GNOME_SETUP_DISPLAY: string;
	export const TURBO_CACHE_DIR: string;
	export const PIP_CACHE_DIR: string;
	export const NX_CACHE_DIRECTORY: string;
	export const UV_CACHE_DIR: string;
	export const PLAYWRIGHT_BROWSERS_PATH: string;
	export const BUNDLE_PATH: string;
	export const XDG_RUNTIME_DIR: string;
	export const ELECTRON_FORCE_WAYLAND: string;
	export const LANG: string;
	export const npm_config_verify_deps_before_run: string;
	export const POWERSHELL_UPDATECHECK: string;
	export const QT_IM_MODULES: string;
	export const XAUTHORITY: string;
	export const XDG_SESSION_DESKTOP: string;
	export const XMODIFIERS: string;
	export const STARSHIP_SESSION_KEY: string;
	export const LS_COLORS: string;
	export const PNPM_STORE_PATH: string;
	export const npm_package_version: string;
	export const npm_lifecycle_event: string;
	export const _JAVA_OPTIONS: string;
	export const AGENT_TRANSCRIPTS: string;
	export const GDMSESSION: string;
	export const QT_ACCESSIBILITY: string;
	export const GRADLE_USER_HOME: string;
	export const npm_config_npm_globalconfig: string;
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
		GTK_THEME: string;
		_ZO_DOCTOR: string;
		GEM_SPEC_CACHE: string;
		PNPM_SCRIPT_SRC_DIR: string;
		npm_command: string;
		npm_config__jsr_registry: string;
		GIT_HTTPS_PROXY: string;
		HTTP_PROXY: string;
		CURSOR_ORIG_GID: string;
		XDG_DATA_DIRS: string;
		npm_execpath: string;
		PWD: string;
		VSCODE_PID: string;
		npm_config_globalconfig: string;
		socks5_proxy: string;
		QT_IM_MODULE: string;
		GPG_AGENT_INFO: string;
		GJS_DEBUG_OUTPUT: string;
		GIT_HTTP_PROXY: string;
		__CURSOR_SANDBOX_ENV_RESTORE: string;
		DOCKER_HOST: string;
		npm_package_json: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		no_proxy: string;
		VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
		ELECTRON_RUN_AS_NODE: string;
		PAGER: string;
		https_proxy: string;
		ZSH: string;
		IM_CONFIG_ENTRY: string;
		CURSOR_WORKSPACE_LABEL: string;
		GIO_LAUNCHED_DESKTOP_FILE: string;
		DOTNET_CLI_TELEMETRY_OPTOUT: string;
		WAYLAND_DISPLAY: string;
		VSCODE_IPC_HOOK: string;
		DISPLAY: string;
		LESS: string;
		COMPOSER_HOME: string;
		STARSHIP_SHELL: string;
		CONDA_PKGS_DIRS: string;
		NPM_CONFIG_CACHE: string;
		ALL_PROXY: string;
		CURSOR_RIPGREP_PATH: string;
		SYSTEMD_EXEC_PID: string;
		LSCOLORS: string;
		GNOME_DESKTOP_SESSION_ID: string;
		VSCODE_NLS_CONFIG: string;
		HTTPS_PROXY: string;
		PATH: string;
		MANAGERPID: string;
		CURSOR_SANDBOX: string;
		SOCKS_PROXY: string;
		BUN_INSTALL_CACHE_DIR: string;
		npm_config_frozen_lockfile: string;
		npm_lifecycle_script: string;
		USER: string;
		CURSOR_ORIG_UID: string;
		npm_config_engine_strict: string;
		PUPPETEER_CACHE_DIR: string;
		COMMAND_NOT_FOUND_INSTALL_PROMPT: string;
		SHLVL: string;
		npm_config_registry: string;
		FORCE_COLOR: string;
		NODE_PATH: string;
		VSCODE_CWD: string;
		CARGO_TARGET_DIR: string;
		NO_COLOR: string;
		npm_config_devdir: string;
		INVOCATION_ID: string;
		GIO_LAUNCHED_DESKTOP_FILE_PID: string;
		NUGET_PACKAGES: string;
		QT_QPA_PLATFORMTHEME: string;
		GDM_LANG: string;
		VSCODE_ESM_ENTRYPOINT: string;
		POWERSHELL_TELEMETRY_OPTOUT: string;
		npm_config_user_agent: string;
		OLDPWD: string;
		VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
		CCACHE_DIR: string;
		CURSOR_EXTENSION_HOST_ROLE: string;
		all_proxy: string;
		DESKTOP_SESSION: string;
		BUN_INSTALL: string;
		CURSOR_SANDBOX_LANDLOCK_STATUS: string;
		MEMORY_PRESSURE_WRITE: string;
		CURSOR_AGENT: string;
		XDG_SESSION_TYPE: string;
		TMPDIR: string;
		npm_node_execpath: string;
		HOMEBREW_CACHE: string;
		CURSOR_LAYOUT: string;
		SSH_AUTH_SOCK: string;
		CHROME_DESKTOP: string;
		NMAP_PRIVILEGED: string;
		HOME: string;
		pnpm_config_verify_deps_before_run: string;
		CP_HOME_DIR: string;
		ELECTRON_USE_GTK: string;
		JOURNAL_STREAM: string;
		MANAGERPIDFDID: string;
		QT_AUTO_SCREEN_SCALE_FACTOR: string;
		_: string;
		XDG_CURRENT_DESKTOP: string;
		INIT_CWD: string;
		GJS_DEBUG_TOPICS: string;
		http_proxy: string;
		GTK2_RC_FILES: string;
		XDG_SESSION_CLASS: string;
		GOMODCACHE: string;
		POETRY_CACHE_DIR: string;
		USERNAME: string;
		VSCODE_PROCESS_TITLE: string;
		socks_proxy: string;
		CYPRESS_CACHE_FOLDER: string;
		FC_FONTATIONS: string;
		NO_PROXY: string;
		SOCKS5_PROXY: string;
		npm_config_node_gyp: string;
		LOGNAME: string;
		MEMORY_PRESSURE_WATCH: string;
		SHELL: string;
		YARN_CACHE_FOLDER: string;
		CURSOR_CONVERSATION_ID: string;
		npm_package_name: string;
		XDG_MENU_PREFIX: string;
		npm_config_cache: string;
		TERM: string;
		NODE: string;
		GDK_BACKEND: string;
		VSCODE_CODE_CACHE_PATH: string;
		GOCACHE: string;
		GNOME_SETUP_DISPLAY: string;
		TURBO_CACHE_DIR: string;
		PIP_CACHE_DIR: string;
		NX_CACHE_DIRECTORY: string;
		UV_CACHE_DIR: string;
		PLAYWRIGHT_BROWSERS_PATH: string;
		BUNDLE_PATH: string;
		XDG_RUNTIME_DIR: string;
		ELECTRON_FORCE_WAYLAND: string;
		LANG: string;
		npm_config_verify_deps_before_run: string;
		POWERSHELL_UPDATECHECK: string;
		QT_IM_MODULES: string;
		XAUTHORITY: string;
		XDG_SESSION_DESKTOP: string;
		XMODIFIERS: string;
		STARSHIP_SESSION_KEY: string;
		LS_COLORS: string;
		PNPM_STORE_PATH: string;
		npm_package_version: string;
		npm_lifecycle_event: string;
		_JAVA_OPTIONS: string;
		AGENT_TRANSCRIPTS: string;
		GDMSESSION: string;
		QT_ACCESSIBILITY: string;
		GRADLE_USER_HOME: string;
		npm_config_npm_globalconfig: string;
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

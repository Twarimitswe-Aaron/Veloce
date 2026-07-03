/** GitHub URL helpers — repo pages are HTML; only raw/blob links are downloadable. */

const GITHUB_REPO_BROWSE =
	/^\/[^/]+\/[^/]+\/?$|^\/[^/]+\/[^/]+\/tree\/|^\/[^/]+\/[^/]+\/wiki(\/|$)/i;

export function isGithubRawUrl(url: string): boolean {
	try {
		return /raw\.githubusercontent\.com/i.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** `github.com/owner/repo/blob/branch/path/file.xml` → raw.githubusercontent.com */
export function githubBlobToRaw(url: string): string | null {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		if (!host.endsWith('github.com') || host === 'raw.githubusercontent.com') return null;
		const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
		if (!m) return null;
		return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
	} catch {
		return null;
	}
}

/** Repository / tree pages — not a direct file download. */
export function isGithubRepoBrowseUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		if (!host.endsWith('github.com') || host === 'raw.githubusercontent.com') return false;
		if (/\/blob\//i.test(u.pathname)) return false;
		return GITHUB_REPO_BROWSE.test(u.pathname);
	} catch {
		return false;
	}
}

export type GithubResolve = { url: string } | { error: string };

/** Normalize GitHub links to a fetchable raw URL, or explain why we cannot. */
export function resolveGithubDownloadUrl(url: string): GithubResolve {
	if (!url) return { error: 'Empty URL.' };
	if (isGithubRawUrl(url)) return { url };

	const raw = githubBlobToRaw(url);
	if (raw) return { url: raw };

	if (isGithubRepoBrowseUrl(url)) {
		return {
			error:
				'GitHub repository page — not a downloadable file. Open a file in the repo, click Raw, then use Veloce on the raw.githubusercontent.com page.'
		};
	}

	try {
		const host = new URL(url).hostname.toLowerCase();
		if (host.endsWith('github.com')) return { url };
	} catch { /* not a URL */ }

	return { url };
}

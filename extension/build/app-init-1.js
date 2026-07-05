
				{
					window.__sveltekit_158wssw = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.CJrOVHHq.js"),
						import("/app/immutable/entry/app.BTPgI0Yr.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			
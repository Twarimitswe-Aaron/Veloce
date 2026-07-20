
				{
					window.__sveltekit_dghzve = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.DiVDpyJG.js"),
						import("/app/immutable/entry/app.CNxmgm7L.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			
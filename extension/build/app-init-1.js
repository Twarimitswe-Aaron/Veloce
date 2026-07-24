
				{
					window.__sveltekit_1q0hkf1 = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.B7BustvI.js"),
						import("/app/immutable/entry/app.CQoSbg3N.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			
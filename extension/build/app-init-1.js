
				{
					window.__sveltekit_15zhke2 = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.Ccmo7luB.js"),
						import("/app/immutable/entry/app.1q1qTJ9b.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			

				{
					window.__sveltekit_1j6t1a4 = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start._HZ9MdEH.js"),
						import("/app/immutable/entry/app.tfp9LdxZ.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			
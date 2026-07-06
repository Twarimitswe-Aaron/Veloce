
				{
					window.__sveltekit_1sfd2gj = {
						base: ""
					};

					const element = document.querySelector('body > div');

					Promise.all([
						import("/app/immutable/entry/start.c_jiycmS.js"),
						import("/app/immutable/entry/app.BcxZmrdw.js")
					]).then(([kit, app]) => {
						kit.start(app, element);
					});
				}
			
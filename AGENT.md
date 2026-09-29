# AGENT.md

## NET_AGENTS Rules

These rules are mandatory for all AI agent operations in this repository:

1. **Master Branch Only**: Only use the `master` branch for all work. Use other branches only if specifically asked to.
2. **Restart & Verify After Code Changes**: Always restart the app and verify it restarts successfully (e.g. `GET /health` returns HTTP 200) after making any code change. Do not report a change as done while the running instance is stale.
3. **Read Docs First**: Check for a `docs/` folder in the root to get an overall summary of the project.
4. **No Local Secrets (`dotnet user-secrets`)**: Do not use `dotnet user-secrets` to store data locally. Put configuration in `appsettings.json` (with `appsettings.Development.json` for local overrides) or Azure Key Vault (if one exists).
5. **Never Push Without Explicit Permission**: Never push code to remote without the user specifically asking, unless the user types `git sync`.
6. **`git sync` Behavior**: When `git sync` happens:
   - Always commit all changes beforehand (leave no dirty working tree).
   - Create a git commit that is short and uses American slang so it reads like a human wrote it.
   - Push the code to remote `master`.
7. **TL;DR on Long Replies**: At the end of any reply longer than 100 words, include a `**TL;DR** …` summary of roughly 20 words.
8. **Targeted Testing Only**: Do not run all tests after code changes. Only run the tests related to the code change, or run no tests at all if the change is simple. Never run full test suites.
9. **Automate CLI Commands**: Avoid making the user manually type in commands to the CLI, or click through a web GUI, if you can do it for them automatically.
10. **Zero Compiler Warnings**: Treat compile warnings as errors and ensure they are fixed immediately.
11. **Flag Big Deletions**: If more than 100 lines of code are removed overall in a prompt, mention it in the reply.
12. **Annotated UI Screenshots**: When a UI change is made, take an annotated screenshot showing the old and new UI with the changes marked. Save the image in the `SCREENSHOTS/` folder at the repo root and give its valid full path in the reply.

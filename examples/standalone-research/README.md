# Standalone research workflow

Eight steps: Entry → Read webpage → Bonsai research → Save findings → Bonsai read/code → Save report → Command verification → Done.

Open the saved **Bonsai Research → Code → Report** workflow in the app. Select an installed model on both Agent steps (the example is configured for the Bonsai model on this Mac). Open **Run settings**, choose a project, an existing folder, or **New folder for this run**, then press **Run**. No Task is created, and unsaved graph changes are included in the run snapshot.

The default access setting asks before reading the website and running the verification command. Use **Run controls → Approve & continue** when prompted. **Stop** cancels the run. Use **Back to editor** to change the graph; the execution snapshot remains unchanged. Save stores the graph and run defaults. Previous executions are available in **Workflows & trace → Run history**.

The webpage step reads public HTML; it does not run JavaScript. The first agent receives that text through **Input context**. Save findings writes the full response to `research/findings.md`. The second agent is instructed to read that file through its tools and generate `sort_domains.py`. The command executes the generated code and checks its actual results.

Both Bonsai nodes set **Thinking budget (tokens)** to **0** for short tool actions. Leave that field empty to use the local model's default, or set a positive budget for harder reasoning. This is a setting for each node; ordinary chats keep their existing behaviour.

Expected files in the run folder:

- `research/findings.md`: research with the IANA source URL.
- `sort_domains.py`: code written by the second agent.
- `sorted-domains.json`: `["example.com", "example.net", "example.org"]`.
- `report.md`: final Markdown report.

Use **Run controls → Open folder** to inspect the files. Runs keep their own logs and the exact graph, input, access, model choices and workspace used for execution. Output quality depends on the selected model; this workflow ends in failure if the verification command fails.

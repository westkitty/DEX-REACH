/**
 * The Desktop Commander adapter's own declaration of its tools.
 *
 * This is adapter-supplied data, not DEX authority. It is deliberately typed `unknown` and a plain
 * literal that imports nothing: it must go through `decodeAdapterManifest` and then be checked
 * against DEX's catalog like any third-party manifest. Deriving it from that catalog would make the
 * check vacuous, so when the two disagree, the node refuses to start and someone reconciles them by
 * hand. That is the intended cost.
 *
 * `version` and `sourceHash` here are placeholders. DEX overwrites them at load time with what it
 * observes on disk, because an adapter stating its own identity is not evidence of it.
 */
export const DESKTOP_COMMANDER_MANIFEST_DATA: unknown = {
  "adapter": "desktop-commander",
  "version": "0.0.0-resolved-at-load",
  "source": "@wonderwhy-er/desktop-commander",
  "sourceHash": null,
  "tools": [
    {
      "tool": "get_config",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "get_file_info",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "get_usage_stats",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "list_directory",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "read_file",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": true,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "read_multiple_files",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [
        "paths"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "start_search",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "get_more_search_results",
      "capability": "file.read",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "list_searches",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "stop_search",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": true,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "create_directory",
      "capability": "file.write",
      "risk": "typed-mutate",
      "mutation": true,
      "network": false,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "checkpoint",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "move_file",
      "capability": "file.write",
      "risk": "typed-mutate",
      "mutation": true,
      "network": false,
      "pathArguments": [
        "source",
        "destination"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "checkpoint",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "write_file",
      "capability": "file.write",
      "risk": "typed-mutate",
      "mutation": true,
      "network": false,
      "pathArguments": [
        "path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "checkpoint",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "write_pdf",
      "capability": "file.write",
      "risk": "typed-mutate",
      "mutation": true,
      "network": false,
      "pathArguments": [
        "path",
        "outputPath"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "checkpoint",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "edit_block",
      "capability": "file.write",
      "risk": "typed-mutate",
      "mutation": true,
      "network": false,
      "pathArguments": [
        "file_path"
      ],
      "workspaceSafeAllowed": true,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "checkpoint",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "start_process",
      "capability": "process.shell",
      "risk": "shell",
      "mutation": true,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "irreversible",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "interact_with_process",
      "capability": "process.shell",
      "risk": "shell",
      "mutation": true,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": true,
      "remoteBlocked": false,
      "reversibility": "irreversible",
      "checkpointStrategy": "git-if-available"
    },
    {
      "tool": "read_process_output",
      "capability": "process.shell",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "list_processes",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "list_sessions",
      "capability": "inspect",
      "risk": "inspect",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "force_terminate",
      "capability": "process.shell",
      "risk": "destructive",
      "mutation": true,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "irreversible",
      "checkpointStrategy": "none"
    },
    {
      "tool": "kill_process",
      "capability": "process.shell",
      "risk": "destructive",
      "mutation": true,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": false,
      "reversibility": "irreversible",
      "checkpointStrategy": "none"
    },
    {
      "tool": "set_config_value",
      "capability": "compat",
      "risk": "privileged",
      "mutation": true,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": true,
      "reversibility": "irreversible",
      "checkpointStrategy": "none"
    },
    {
      "tool": "get_recent_tool_calls",
      "capability": "compat",
      "risk": "privileged",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": true,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "give_feedback_to_desktop_commander",
      "capability": "compat",
      "risk": "network",
      "mutation": false,
      "network": true,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": true,
      "reversibility": "none",
      "checkpointStrategy": "none"
    },
    {
      "tool": "get_prompts",
      "capability": "compat",
      "risk": "privileged",
      "mutation": false,
      "network": false,
      "pathArguments": [],
      "workspaceSafeAllowed": false,
      "supportsPlan": false,
      "remoteBlocked": true,
      "reversibility": "none",
      "checkpointStrategy": "none"
    }
  ]
};

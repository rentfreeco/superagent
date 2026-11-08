import type { AgentAccount } from "./resolve-agent-account.ts";

const TOKEN_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';

/**
 * A process environment that acts on GitHub as the agent: gh through
 * GH_TOKEN, and git pushing over https with the same token even where a
 * remote is SSH, ignoring the machine's own credential helpers, and
 * authoring commits as the agent.
 */
export const agentAccountEnvironment = ({
  token,
  login,
  email,
}: AgentAccount): Record<string, string> => {
  const gitConfig = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", TOKEN_CREDENTIAL_HELPER],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  return {
    GH_TOKEN: token,
    GIT_AUTHOR_NAME: login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: login,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: String(gitConfig.length),
    ...Object.fromEntries(
      gitConfig.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
};

export const PROJECT_INSTALLER_VERSION = '0.1.34';
export const PROJECT_INSTALLER_SPEC = `@spala-ai/mcp-install@${PROJECT_INSTALLER_VERSION}`;
export const INSTALLER_MAINTENANCE_SPEC = '@spala-ai/mcp-install@latest';

export const INSTALLER_UPDATE_POLICY = 'Check the project proxy installer version at the start of each working session. If it is older than testedVersion, ask the agent to reconnect the same bound project with public project_connect, execute the returned exact installer argv, and reload at a safe stopping point. New proxies check again every 15 minutes of tool activity and announce each newer tested version once per session. Do not read credential stores, start parallel OAuth, or automatically change projects. Unknown versions are not proof of being current. Native plugins and skills use their own update mechanisms.';

export function installerUpdate(installedVersion?: string) {
  const valid = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)));
  let status = 'unknown';
  if (installedVersion && valid(installedVersion)) {
    const installed = installedVersion.split('.').map(Number);
    const tested = PROJECT_INSTALLER_VERSION.split('.').map(Number);
    const index = tested.findIndex((part, i) => part !== installed[i]);
    status = index < 0 ? 'current' : tested[index]! > installed[index]! ? 'update_available' : 'newer_than_tested';
  }
  return {
    package: '@spala-ai/mcp-install',
    installedVersion: installedVersion ?? null,
    testedVersion: PROJECT_INSTALLER_VERSION,
    status,
    policy: INSTALLER_UPDATE_POLICY,
    ...(status === 'update_available' ? { nextAction: { tool: 'project_connect', instruction: 'Reconnect the currently bound project with the current client, run the exact returned installer plan, then reload. Keep the existing project selection.' } } : {}),
  };
}

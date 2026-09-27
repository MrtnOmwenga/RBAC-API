export const TEMPLATE_DB = 'rbac_template';
/** The API's login role. Its password is generated in global-setup.ts and inherited by the workers. */
export const appLogin = () => ({ user: 'rbac_app_login', password: process.env.TEST_APP_DB_PASSWORD ?? '' });

/** The same server, another database, optionally as another user. */
export function withDatabase(url: string, database: string, login?: { user: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (login) {
    u.username = login.user;
    u.password = login.password;
  }
  return u.toString();
}

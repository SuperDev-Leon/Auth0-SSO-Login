import Auth0Lock from 'auth0-lock';
import auth0 from 'auth0-js';

// static window interaction, mostly wrapped for enabling easier mocking through unit tests
export class windowInteraction {
  static updateWindow(url) {
    window.location = url;
  }

  static setTimeout(func, delay) {
    return window.setTimeout(func, delay);
  }

  static clearTimeout(timeoutId) {
    window.clearTimeout(timeoutId);
  }
}

// consider token expired after second third of its lifetime
const getRemainingMillisToTokenEpxiry = (authResult) => {
  const tokenExpiresAt = (authResult.expiresIn * 1000) + Date.now();
  return Math.floor((tokenExpiresAt - Date.now()) / 3) * 2;
};

// authentication class
export default class auth {
  /**
   * @constructor constructs the object with a given configuration
   * @param {Object} config
   */
  constructor(config) {
    this.config = config || {};
    this.tokenRefreshHandle = null;
    this.authResult = null;
  }

  /**
   * @description logs the message to the console, or to a provided hook
   * @param message to log
   * @return {*|void}
   */
  log(message) {
    const logFunc = (this.config.hooks ? this.config.hooks.log : undefined) || console.log;
    return logFunc(message);
  }

  /**
   * @description gets the detailed profile with a call to the Auth0 Management API
   * @param idToken
   * @param sub
   * @return {Promise<any>} resolved promise with user profile; rejected promise with error
   */
  getDetailedProfile(idToken, sub) {
    return new Promise((resolve, reject) => {
      const auth0Manager = new auth0.Management({
        domain: this.config.domain,
        token: idToken,
      });
      auth0Manager.getUser(sub, (error, profile) => {
        if (error) {
          reject(error);
        } else {
          resolve(profile);
        }
      });
    });
  }

  /**
   * @description the latest authorization result with access token
   * @return {null|Object} authResult if the user was already logged in; null otherwise
   */
  getLatestAuthResult() {
    return this.authResult;
  }

  /**
   * @description calls a hook once the profile got refreshed
   * @param profile user profile retrieved from auth0 manager
   * @return {*}
   */
  profileRefreshed(profile) {
    if (this.config.hooks && this.config.hooks.profileRefreshed) {
      return this.config.hooks.profileRefreshed(profile);
    }
    return Promise.resolve();
  }

  /**
   * @description Calls a hook once the token got refreshed
   * @param authResult authorization result returned by auth0
   * @return {*}
   */
  tokenRefreshed(authResult) {
    this.authResult = authResult;

    if (this.tokenRefreshHandle) {
      windowInteraction.clearTimeout(this.tokenRefreshHandle);
    }
    this.tokenRefreshHandle = windowInteraction.setTimeout(
      () => this.ensureLoggedIn({ enableLockWidget: true }),
      getRemainingMillisToTokenEpxiry(authResult));

    if (this.config.hooks && this.config.hooks.tokenRefreshed) {
      return this.config.hooks.tokenRefreshed(authResult);
    }
    return Promise.resolve();
  }

  /**
   * Calls a hook once the login should be removed
   * @return {*}
   */
  removeLogin() {
    if (this.tokenRefreshHandle) {
      windowInteraction.clearTimeout(this.tokenRefreshHandle);
      this.authResult = null;
    }

    if (this.config.hooks && this.config.hooks.removeLogin) {
      return this.config.hooks.removeLogin();
    }
    return Promise.resolve();
  }

  /**
   * @description Calls a hook to log out the user, and then interacts with Auth0 to actually
   * log the user out.
   */
  logout() {
    if (this.tokenRefreshHandle) {
      windowInteraction.clearTimeout(this.tokenRefreshHandle);
      this.authResult = null;
    }

    if (this.config) {
      if (this.config.hooks && this.config.hooks.logout) {
        this.config.hooks.logout();
      }
      const redirectUri = encodeURIComponent(this.config.logoutRedirectUri);
      windowInteraction.updateWindow(`https://${this.config.domain}/v2/logout?returnTo=${redirectUri}&client_id=${this.config.clientId}`);
    }
  }

  /**
   * @description Try to login, first using an existing SSO session. If that fails and auth0 lock
   * widget is not explicitly disabled, show auth0 lock to the user.
   *
   * @param {Object}     configuration object
   * @param {Boolean}    configuration.enableLockWidget whether auth0 lock should open when SSO
   *                     session is invalid; default = true
   * @return {Promise<>} empty resolved promise after successful login; rejected promise with error
   *                     otherwise
   */
  ensureLoggedIn(configuration = { enableLockWidget: true }) {
    // if there is still a valid token, there is no need to initiate the login process
    const latestAuthResult = this.getLatestAuthResult();
    if (latestAuthResult && getRemainingMillisToTokenEpxiry(latestAuthResult) > 0) {
      return Promise.resolve();
    }

    let options = {
      auth: {
        params: {
          responseType: 'id_token token',
        },
        redirect: false,
      },
      closable: false,
    };
    if (this.config.auth0LockOptions) {
      options = Object.assign(options, this.config.auth0LockOptions);
    }

    // The 1000ms here is guarantee that the websocket is finished loading
    return this.renewAuth()
      .catch((e) => {
        this.removeLogin();
        // if auth0 lock is not enabled, error out
        if (!configuration.enableLockWidget) {
          return Promise.reject(e);
        }
        this.log('Renew authorization did not succeed, falling back to login widget', e);
        return new Promise((resolve, reject) => {
          const lock = new Auth0Lock(this.config.clientId, this.config.domain, options);
          lock.on('authenticated', (authResult) => {
            this.renewAuth()
              .then(() => {
                lock.getUserInfo(authResult.accessToken, (error, profile) => {
                  lock.hide();
                  if (error) {
                    this.log(error);
                    reject(error);
                  } else {
                    resolve({
                      idToken: authResult.idToken,
                      sub: profile.sub,
                    });
                  }
                });
              });
          });

          lock.on('authorization_error', (error) => {
            this.log(error);
            reject(error);
          });

          lock.show();
        });
      })
      .then(loginInfo => this.getDetailedProfile(loginInfo.idToken, loginInfo.sub))
      .then(profile => this.profileRefreshed(profile));
  }

  /**
   * @description renews the authentication
   * @param {Number} retries current retry attempt number
   * @return {Promise<any>}
   */
  renewAuth(retries = 0) {
    const webAuth = new auth0.WebAuth({
      domain: this.config.domain,
      clientID: this.config.clientId,
    });
    const renewOptions = {
      redirectUri: this.config.loginRedirectUri,
      usePostMessage: true,
      audience: this.config.audience,
      responseType: 'id_token token',
    };

    return new Promise((resolve, reject) => {
      webAuth.renewAuth(renewOptions, (err, authResult) => {
        if (err) {
          this.log(`Failed to update ID token on retry ${retries}: ${JSON.stringify(err)}`);
          reject(err);
          return;
        }
        if (authResult && authResult.accessToken && authResult.idToken) {
          this.tokenRefreshed(authResult)
            .then(() => {
              resolve({
                idToken: authResult.idToken,
                sub: authResult.idTokenPayload.sub,
              });
            });
        } else {
          reject({ error: 'no_token_available', errorDescription: 'Failed to get valid token.', authResultError: authResult.error });
        }
      });
    })
      .catch((error) => {
        if (retries < 4 && error.authResultError === undefined) {
          return new Promise(resolve => setTimeout(() => resolve(), 1000))
            .then(() => this.renewAuth(retries + 1));
        }
        throw error;
      });
  }
}

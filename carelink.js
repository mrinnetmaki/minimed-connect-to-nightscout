/* jshint node: true */
"use strict";

var _ = require('lodash'),
    axios = require('axios').default,
    axiosCookieJarSupport = require('axios-cookiejar-support').default,
    tough = require('tough-cookie'),
    qs = require('qs');

var CARELINK_EU = process.env['MMCONNECT_SERVER'] === 'EU';

var DEFAULT_MAX_RETRY_DURATION = module.exports.defaultMaxRetryDuration = 512;
var carelinkServerAddress = CARELINK_EU ? "carelink.minimed.eu" : "carelink.minimed.com";

var CARELINKEU_LOGIN_URL = 'https://' + carelinkServerAddress + '/patient/sso/login?country=gb&lang=en';
var CARELINKEU_REFRESH_TOKEN_URL = 'https://' + carelinkServerAddress + '/patient/sso/reauth';
var CARELINKEU_JSON_BASE_URL = 'https://' + carelinkServerAddress + '/patient/connect/data?cpSerialNumber=NONE&msgType=last24hours&requestTime=';
var CARELINKEU_TOKEN_COOKIE = 'auth_tmp_token';
var CARELINKEU_TOKENEXPIRE_COOKIE = 'c_token_valid_to';

var CARELINK_SECURITY_URL = 'https://' + carelinkServerAddress + '/patient/j_security_check';
var CARELINK_AFTER_LOGIN_URL = 'https://' + carelinkServerAddress + '/patient/main/login.do';
var CARELINK_JSON_BASE_URL = 'https://' + carelinkServerAddress + '/patient/connect/ConnectViewerServlet?cpSerialNumber=NONE&msgType=last24hours&requestTime=';
var CARELINK_LOGIN_COOKIE = '_WL_AUTHCOOKIE_JSESSIONID';

var carelinkJsonUrlNow = function () {
    return (CARELINK_EU ? CARELINKEU_JSON_BASE_URL : CARELINK_JSON_BASE_URL) + Date.now();
};

var Client = exports.Client = function (options = {}) {
    if (!(this instanceof Client)) {
        return new Client(arguments[0]);
    }

    const logger = require('./logger');

    if (options.verbose) {
        logger.setVerbose();
    }

    const axiosInstance = axios.create({});

    axiosCookieJarSupport(axiosInstance);
    axiosInstance.defaults.jar = new tough.CookieJar();
    axiosInstance.defaults.maxRedirects = 0;
    axiosInstance.defaults.withCredentials = true;
    axiosInstance.interceptors.response.use(function (response) {
        // Do something with response data
        return response;
    }, function (error) {
        if (error.response && error.response.status >= 200 && error.response.status < 400) {
            return error.response;
        } else {
            // Do something with response error
            return Promise.reject(error);
        }
    });

    if (options.maxRetryDuration === undefined) {
        options.maxRetryDuration = DEFAULT_MAX_RETRY_DURATION;
    }

    function getCookies() {
        let cookies = [];
        axiosInstance.defaults.jar.store.getAllCookies(function (err, cookieArray) {
            if (err)
                cookies = [];
            cookies = cookieArray;
        });

        return cookies.filter(c => c.domain === carelinkServerAddress);
    }

    function haveCookie(cookieName) {
        return _.some(getCookies(), {key: cookieName});
    }

    function getCookie(cookieName) {
        return _.find(getCookies(), {key: cookieName});
    }

    async function doLogin() {
        return await axiosInstance.post(
            CARELINK_SECURITY_URL,
            qs.stringify({
                j_username: options.username,
                j_password: options.password,
                j_character_encoding: "UTF-8"
            }));
    }

    async function doFetchCookie() {
        return await axiosInstance.get(CARELINK_AFTER_LOGIN_URL);
    }

    async function doLoginEu1() {
        return await axiosInstance.get(CARELINKEU_LOGIN_URL);
    }

    async function doLoginEu2(response) {
        return await axiosInstance.get(response.headers.location);
    }

    async function doLoginEu3(response) {
        let uri = new URL(response.headers.location);
        let uriParam = uri.searchParams;

        let url = `${uri.origin}${uri.pathname}?locale=${uriParam.get('locale')}&countrycode=${uriParam.get('countrycode')}`;

        response = await axiosInstance.post(url, qs.stringify({
            sessionID: uriParam.get('sessionID'),
            sessionData: uriParam.get('sessionData'),
            locale: "en",
            action: "login",
            username: options.username,
            password: options.password,
            actionButton: "Log in",
        }));

        if (_.get(response, 'data', '').includes(uri.pathname))
            throw new Error('Carelink invalid username or password');

        return response;
    }

    async function doLoginEu4(response) {
        let regex = /(<form action=")(.*)" method="POST"/gm;
        let url = (regex.exec(response.data) || [])[2] || '';

        // Session data is changed, need to get it from the html body form
        regex = /(<input type="hidden" name="sessionID" value=")(.*)"/gm;
        let sessionId = (regex.exec(response.data) || [])[2] || '';

        regex = /(<input type="hidden" name="sessionData" value=")(.*)"/gm;
        let sessionData = (regex.exec(response.data)[2] || []) || '';

        return await axiosInstance.post(url, qs.stringify({
            action: "consent",
            sessionID: sessionId,
            sessionData: sessionData,
            response_type: "code",
            response_mode: "query",
        }), {
            maxRedirects: 0,
        });
    }

    async function doLoginEu5(response) {
        return await axiosInstance.get(response.headers.location, {maxRedirects: 0});
    }

    async function refreshTokenEu(alternativeHeaders) {
        const headers = alternativeHeaders || {
            Authorization: "Bearer " + _.get(getCookie(CARELINKEU_TOKEN_COOKIE), 'value', ''),
        };
        return await axiosInstance.post(
            CARELINKEU_REFRESH_TOKEN_URL,
            {},
            {
                headers,
            },
        ).catch((error) => {
            if (error.response && error.response.status === 403) {
                if (!alternativeHeaders) {
                    // Try with just a different user agent
                    logger.log('Got HTTP 403, trying with alternative user agent');
                    return refreshTokenEu({
                        Authorization: "Bearer " + (getCookie(CARELINKEU_TOKEN_COOKIE) || ''),
                        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:83.0) Gecko/20100101 Firefox/83.0",
                    });
                }
                if (!alternativeHeaders.Authorization) {
                    // Try with modified cookie settings too
                    logger.log('Still got HTTP 403, trying with an empty cookie');
                    return refreshTokenEu({
                        Authorization: "Bearer " + (getCookie(CARELINKEU_TOKEN_COOKIE) || ''),
                        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:83.0) Gecko/20100101 Firefox/83.0",
                        Cookie: '',
                    });
                }
            }
            throw error;
        }).catch((error) => {
            const status = error.response ? error.response.status : undefined;
            if (status === 401 || status === 403) {
                // Login again
                logger.log('Got HTTP ' + status + ', trying with a fresh login...');
                return checkLogin(true);
            }
            throw error;
        });
    }        
 
    async function getConnectData() {
        var url = carelinkJsonUrlNow();
        logger.log('GET ' + url);

        var config = {
            headers: {},
        };
        if (CARELINK_EU) {
            config.headers.Authorization = "Bearer " + _.get(getCookie(CARELINKEU_TOKEN_COOKIE), 'value', '');
        }

        return await axiosInstance.get(url, config);
    }

    async function checkLogin(relogin = false) {
        if (CARELINK_EU) {
            // EU - SSO method
            if (!relogin && (haveCookie(CARELINKEU_TOKEN_COOKIE) || haveCookie(CARELINKEU_TOKENEXPIRE_COOKIE))) {
                let expire = new Date(Date.parse(_.get(getCookie(CARELINKEU_TOKENEXPIRE_COOKIE), 'value')));

                // Refresh token if expires in 10 minutes
                if (expire < new Date(Date.now() + 10 * 1000 * 60))
                    await refreshTokenEu();
            } else {
                logger.log('Logging in to CareLink');
                let response = await doLoginEu1();
                response = await doLoginEu2(response);
                response = await doLoginEu3(response);
                response = await doLoginEu4(response);
                await doLoginEu5(response);
            }
        } else {
            // US - Cookie method
            if (!haveCookie(CARELINK_LOGIN_COOKIE)) {
                logger.log('Logging in to CareLink');
                let response = await doLogin()
                await doFetchCookie(response)
            }
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    async function fetch(callback) {
        try {
            let maxRetry = 3;
            for (let i = 1; i <= maxRetry; i++) {
                await checkLogin();
                try {
                    let response = await getConnectData();
                    callback(null, response.data);
                    return;
                } catch (e1) {
                    if (i === maxRetry)
                        throw e1;

                    if (e1.response && e1.response.status === 401) {
                        // reauth
                        axiosInstance.defaults.jar.removeAllCookiesSync();
                    }

                    let timeout = retryDurationOnAttempt(i);
                    await sleep(1000 * timeout);
                }
            }

            throw new Error('Failed to download Carelink data');
        } catch (e) {
            callback(e, null);
        }
    }

    return {
        fetch: fetch
    };
};

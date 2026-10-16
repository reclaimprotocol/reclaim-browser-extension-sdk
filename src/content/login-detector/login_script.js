// Source: reclaim-portal/packages/browser-events/scripts/login_script.js (copied verbatim below; re-sync from there)
const __hasLoginElementInPage = () => {
    function hasElementByXPath(
        // type: string
        xpath,
    ) {
        // Evaluate the XPath and return true if an element is found
        return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    };

    function hasElementByPhrase(
        // Define the list of phrases to match
        // type: string[]
        phrases,
    ) {
        // Dynamically build the XPath conditions from the list
        const conditions = phrases.map(e => e.toLowerCase())
            .map(phrase => `translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = '${phrase}'`)
            .join(' or ');

        // Construct the final XPath
        const xpath = `//*[${conditions}]`;

        const valueConditions = phrases.map(e => e.toLowerCase())
            .map(phrase => `translate(normalize-space(@value), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = '${phrase}'`)
            .join(' or ');

        // Construct the final XPath for value
        const valueXpath = `//*[${valueConditions}]`;

        // Evaluate the XPath and return true if an element is found
        return hasElementByXPath(xpath) || hasElementByXPath(valueXpath);
    };

    function hasElementByPropertyValue(
        // type: string
        valueType,
        // Define the list of tokens to match
        // type: string[]
        tokens,
        elementType,
    ) {
        const valueConditions = tokens.map(e => e.toLowerCase())
            .map(token => `@${valueType} = '${token}'`)
            .join(' or ');

        // Construct the final XPath for value
        const valueXpath = `//${elementType || '*'}[${valueConditions}]`;

        // Evaluate the XPath and return true if an element is found
        return hasElementByXPath(valueXpath);
    };

    // Define the list of phrases to match
    const loginPhrases = [
        'sign in',
        'log in with',
        'sign in with',
        'login with',
        'signin with',
        'signin',
        'log in',
        'login',
        'sign up',
        'signup',
        'resend',
        'sign up now',
        'sign in now',
        'create account',
        'create an account',
        'sign up or sign in',
        'sign in or create an account',
        'sign in or create account',
        'log in or create an account',
        'log in or create account',
        'sign in or sign up',
        'log in or sign up',
        'login or signup',
        'already have an account? sign in',
        'already have an account? signin',
        'already have an account? log in',
        'already have an account? login',
        'forgot password',
        'forgot password?',
        'forgotten password?',
        'forgotten password',
        'forgotten your password?',
        'forgotten your password',
        'reset password',
        'reset password?',
        'reset your password',
        'reset your password?',
        'recover password?',
        'recover password',
        'recover your password?',
        'recover your password',
        'recaptcha',
        'captcha',
    ];

    // known false positive example: https://github.com/settings/emails (pages that lets user update their profile information)
    // reference: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input#input_types
    const inputTypeTokens = [
        'email',
        'password',
        'tel',
    ];

    // reference: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete#value
    const inputAutocompleteTokens = [
        'email',
        'password',
        'username',
        'mobile',
        'tel',
        'tel-national',
        'one-time-code',
    ];

    return hasElementByPhrase(loginPhrases) || hasElementByPropertyValue('type', inputTypeTokens, 'input') || hasElementByPropertyValue('autocomplete', inputAutocompleteTokens, 'input');
}

const __isLoginUrl = () => {
    const fullUrl = window.location.href.toLowerCase();
    const lowercaseUrlPath = window.location.pathname.toLowerCase();
    const lowercaseUrlQuery = window.location.search.toLowerCase();
    const lowercaseUrlFragment = window.location.hash.toLowerCase();

    const loginTokens = ['login', 'log-in', 'signin', 'signup', 'sign-in', 'sign-up', 'sign_in', 'sign_up', 'log_in', 'accounts.google.com', 'accountchooser'];
    const mfaTokens = ['two-factor', 'two_factor', '2-factor', '2fa', 'mfa', 'otp', 'recaptcha', 'captcha', 'sso', 'openid-connect'];
    // user may be redirected to login page that says logout in the url (e.g twitter)
    const logoutTokens = ['logout', 'signout', 'sign_out', 'log_out'];

    const maybeLoginPathTokens = [...loginTokens, ...mfaTokens, 'auth', 'oauth', ...logoutTokens];
    const maybeLoginQueryTokens = [...loginTokens, ...mfaTokens, ...logoutTokens];

    const isInLoginPath = (token) => {
        if (lowercaseUrlPath != null && lowercaseUrlPath.includes(token)) {
            return true;
        }
        if (lowercaseUrlFragment != null && lowercaseUrlFragment.includes(token)) {
            return true;
        }
        return false;
    }

    const isInLoginQuery = (token) => {
        return lowercaseUrlQuery != null && lowercaseUrlQuery.includes(token);
    }

    return maybeLoginPathTokens.find(isInLoginPath) ||
        maybeLoginQueryTokens.find(isInLoginQuery) ||
        maybeLoginPathTokens.find(token => fullUrl.includes(token));
}

// Register the check with the Reclaim runtime instead of exposing a
// window-level function. Anti-bot scanners walking
// Object.getOwnPropertyNames(window) won't see any login-related globals.
const __maybeRequiresLoginInteraction = () => {
    try {
        if (__isLoginUrl()) return 'url';
        return __hasLoginElementInPage() ? 'element' : 'none';
    } catch (e) {
        console.warn('failed to check login interaction requirement', e);
        return false;
    }
};
// reclaim_env.js is registered as an init script BEFORE login_script.js
// (web-page-manager.ts), so window.Reclaim exists by the time we run.
// Guard anyway for safety.
if (window.Reclaim && typeof window.Reclaim._setLoginCheck === 'function') {
    window.Reclaim._setLoginCheck(__maybeRequiresLoginInteraction);
}

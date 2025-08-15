# Spotify Web API — Auth & Search (Clean Reference)

This doc summarizes the Spotify OAuth flows used in this repo and the core Search and Profile endpoints, with compact, readable examples.

## Bases

- Web API base: `https://api.spotify.com/v1`
- Accounts base: `https://accounts.spotify.com`

Note: When composing URLs with the Web API base, do not prefix the path with `/` if using the `URL` constructor against the base, or you may drop `/v1`.

---

## OAuth Flows

### Authorization Code (server-side)

1. Request user authorization

- GET `https://accounts.spotify.com/authorize`
- Query params:
  - `client_id`: your app Client ID
  - `response_type=code`
  - `redirect_uri`: must exactly match one allow‑listed in the app dashboard
  - `state` (recommended): CSRF protection
  - `scope` (optional): space‑separated scopes
  - `show_dialog` (optional)

Example (Node/Express redirect):

```js
const scope = "user-read-private user-read-email";
res.redirect(
  "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: process.env.SPOTIFY_CLIENT_ID,
      scope,
      redirect_uri: "http://127.0.0.1:8888/callback",
      state: crypto.randomUUID(),
    }).toString()
);
```

2. Exchange `code` for access token

- POST `https://accounts.spotify.com/api/token`
- Headers: `Authorization: Basic base64(client_id:client_secret)`, `Content-Type: application/x-www-form-urlencoded`
- Body: `grant_type=authorization_code&code=...&redirect_uri=...`

Example (Node/fetch):

```js
const body = new URLSearchParams({
  grant_type: "authorization_code",
  code,
  redirect_uri: "http://127.0.0.1:8888/callback",
});

const resp = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
  },
  body,
});
const tokens = await resp.json(); // { access_token, refresh_token, expires_in, token_type }
```

3. Refresh access token

- POST `https://accounts.spotify.com/api/token`
- Headers: `Content-Type: application/x-www-form-urlencoded`
- Body: `grant_type=refresh_token&refresh_token=...` (+ `Authorization: Basic ...` for non‑PKCE)

```bash
curl --request POST \
  --url https://accounts.spotify.com/api/token \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --header 'Authorization: Basic BASE64(client_id:client_secret)' \
  --data 'grant_type=refresh_token&refresh_token=REFRESH_TOKEN'
```

### Authorization Code with PKCE (public clients)

1. Create Code Verifier and Code Challenge

```js
const generateVerifier = (len = 64) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
};

const sha256 = async (plain) => {
  const enc = new TextEncoder();
  return crypto.subtle.digest("SHA-256", enc.encode(plain));
};

const base64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const verifier = generateVerifier();
const challenge = base64url(await sha256(verifier));
localStorage.setItem("code_verifier", verifier);
```

2. Authorize

```js
const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.search = new URLSearchParams({
  client_id: "YOUR_CLIENT_ID",
  response_type: "code",
  redirect_uri: "http://127.0.0.1:8080",
  scope: "user-read-private user-read-email",
  code_challenge_method: "S256",
  code_challenge: challenge,
}).toString();
window.location.href = authUrl.toString();
```

3. Exchange code for token (PKCE)

```js
const code = new URLSearchParams(window.location.search).get("code");
const code_verifier = localStorage.getItem("code_verifier");
const resp = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "YOUR_CLIENT_ID",
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://127.0.0.1:8080",
    code_verifier,
  }),
});
const tokens = await resp.json();
```

### Client Credentials (app token, no user)

For server‑to‑server requests that don’t access user data (e.g., Search):

```bash
curl --request POST \
  --url https://accounts.spotify.com/api/token \
  --header 'Authorization: Basic BASE64(client_id:client_secret)' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials'
```

Response:

```json
{ "access_token": "...", "token_type": "Bearer", "expires_in": 3600 }
```

---

## Search API

Get catalog information for albums, artists, playlists, tracks, shows, episodes, or audiobooks matching a query.

- GET `/v1/search`
- Query params:
  - `q` (required)
  - `type` (required) — comma‑separated: `album,artist,playlist,track,show,episode,audiobook`
  - `market` (optional, ISO code)
  - `limit` (default 20, 1..50)
  - `offset` (default 0, 0..1000)
  - `include_external=audio` (optional)

Example:

```bash
curl --request GET \
  --url 'https://api.spotify.com/v1/search?q=instant%20crush%20daft%20punk&type=track&limit=3' \
  --header 'Authorization: Bearer YOUR_APP_OR_USER_TOKEN'
```

Response (trimmed):

```json
{
  "tracks": {
    "href": "https://api.spotify.com/v1/search?...",
    "limit": 3,
    "offset": 0,
    "total": 3,
    "items": [
      {
        "id": "4cJPC6Y0d1ias1xK2lB9S2",
        "name": "Instant Crush",
        "uri": "spotify:track:4cJPC6Y0d1ias1xK2lB9S2",
        "artists": [{ "id": "4tZwfgrHOc3mvqYlEYSvVi", "name": "Daft Punk" }],
        "album": {
          "id": "4m2880jivSbbyEGAKfITCa",
          "name": "Random Access Memories"
        },
        "duration_ms": 337093
      }
    ]
  }
}
```

---

## Get Current User's Profile

Get detailed profile information about the current user.

- GET `/v1/me`
- Scopes: `user-read-private`, `user-read-email` (to include email)

```bash
curl --request GET \
  --url https://api.spotify.com/v1/me \
  --header 'Authorization: Bearer USER_ACCESS_TOKEN'
```

Response (trimmed):

```json
{
  "id": "wizzler",
  "display_name": "Daniel Ek",
  "country": "SE",
  "email": "user@example.com",
  "product": "premium",
  "images": [
    { "url": "https://i.scdn.co/image/…", "height": 300, "width": 300 }
  ],
  "external_urls": { "spotify": "https://open.spotify.com/user/wizzler" },
  "href": "https://api.spotify.com/v1/users/wizzler",
  "type": "user",
  "uri": "spotify:user:wizzler"
}
```

---

## Notes & Gotchas

- Token lifetimes are short (~1h). For long‑lived sessions, refresh when needed.
- Market filtering affects playability and availability.
- Search limits are per type; always echo your effective `limit`/`offset` and totals.

# Authorization Code Flow

The authorization code flow is suitable for long-running applications (e.g. web and mobile apps) where the user grants permission only once.

If you’re using the authorization code flow in a mobile app, or any other type of application where the client secret can't be safely stored, then you should use the PKCE extension. Keep reading to learn how to correctly implement it.

The following diagram shows how the authorization code flow works:

Authorization Code Flow

Pre-requisites
This guide assumes that:

You have read the authorization guide.
You have created an app following the apps guide.
Example
You can find an example app implementing Authorization Code flow on GitHub in the web-api-examples repository.

Request User Authorization
The first step is to request authorization from the user so that our app can access to the Spotify resources on the user's behalf. To do this, our application must build and send a GET request to the /authorize endpoint with the following parameters:

Query Parameter Relevance Value
client_id Required The Client ID generated after registering your application.
response_type Required Set to code.
redirect_uri Required The URI to redirect to after the user grants or denies permission. This URI needs to have been entered in the Redirect URI allowlist that you specified when you registered your application (See the app guide). The value of redirect_uri here must exactly match one of the values you entered when you registered your application, including upper or lowercase, terminating slashes, and such.
state Optional, but strongly recommended This provides protection against attacks such as cross-site request forgery. See RFC-6749.
scope Optional A space-separated list of scopes.If no scopes are specified, authorization will be granted only to access publicly available information: that is, only information normally visible in the Spotify desktop, web, and mobile players.
show_dialog Optional Whether or not to force the user to approve the app again if they’ve already done so. If false (default), a user who has already approved the application may be automatically redirected to the URI specified by redirect_uri. If true, the user will not be automatically redirected and will have to approve the app again.
The following JavaScript code example implements the /login method using Express framework to initiates the authorization request:

var client_id = 'CLIENT_ID';
var redirect_uri = 'http://127.0.0.1:8888/callback';

var app = express();

app.get('/login', function(req, res) {

var state = generateRandomString(16);
var scope = 'user-read-private user-read-email';

res.redirect('https://accounts.spotify.com/authorize?' +
querystring.stringify({
response_type: 'code',
client_id: client_id,
scope: scope,
redirect_uri: redirect_uri,
state: state
}));
});

Once the request is processed, the user will see the authorization dialog asking to authorize access within the user-read-private and user-read-email scopes.

The Spotify OAuth 2.0 service presents details of the scopes for which access is being sought. If the user is not logged in, they are prompted to do so using their Spotify credentials. When the user is logged in, they are asked to authorize access to the data sets or features defined in the scopes.

Finally, the user is redirected back to your specified redirect_uri. After the user accepts, or denies your request, the Spotify OAuth 2.0 service redirects the user back to your redirect_uri. In this example, the redirect address is https://127.0.0.1:8888/callback

Response
If the user accepts your request, then the user is redirected back to the application using the redirect_uri passed on the authorized request described above.

The callback contains two query parameters:

Query Parameter Value
code An authorization code that can be exchanged for an access token.
state The value of the state parameter supplied in the request.
For example:

https://my-domain.com/callback?code=NApCCg..BkWtQ&state=34fFs29kd09

If the user does not accept your request or if an error has occurred, the response query string contains the following parameters:

Query Parameter Value
error The reason authorization failed, for example: "access_denied"
state The value of the state parameter supplied in the request.
For example:

https://my-domain.com/callback?error=access_denied&state=34fFs29kd09

In both cases, your app should compare the state parameter that it received in the redirection URI with the state parameter it originally provided to Spotify in the authorization URI. If there is a mismatch then your app should reject the request and stop the authentication flow.

Request an access token
If the user accepted your request, then your app is ready to exchange the authorization code for an access token. It can do this by sending a POST request to the /api/token endpoint.

The body of this POST request must contain the following parameters encoded in application/x-www-form-urlencoded:

Body Parameters Relevance Value
grant_type Required This field must contain the value "authorization_code".
code Required The authorization code returned from the previous request.
redirect_uri Required This parameter is used for validation only (there is no actual redirection). The value of this parameter must exactly match the value of redirect_uri supplied when requesting the authorization code.
The request must include the following HTTP headers:

Header Parameter Relevance Value
Authorization Required Base 64 encoded string that contains the client ID and client secret key. The field must have the format: Authorization: Basic <base64 encoded client_id:client_secret>
Content-Type Required Set to application/x-www-form-urlencoded.
This step is usually implemented within the callback described on the request of the previous steps:

app.get('/callback', function(req, res) {

var code = req.query.code || null;
var state = req.query.state || null;

if (state === null) {
res.redirect('/#' +
querystring.stringify({
error: 'state_mismatch'
}));
} else {
var authOptions = {
url: 'https://accounts.spotify.com/api/token',
form: {
code: code,
redirect_uri: redirect_uri,
grant_type: 'authorization_code'
},
headers: {
'content-type': 'application/x-www-form-urlencoded',
'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64'))
},
json: true
};
}
});

Response
On success, the response will have a 200 OK status and the following JSON data in the response body:

key Type Description
access_token string An access token that can be provided in subsequent calls, for example to Spotify Web API services.
token_type string How the access token may be used: always "Bearer".
scope string A space-separated list of scopes which have been granted for this access_token
expires_in int The time period (in seconds) for which the access token is valid.
refresh_token string See refreshing tokens.
What's next?
Congratulations! Your fresh access token is ready to be used! How can we make API calls with it? take a look at to the access token guide to learn how to make an API call using your new fresh access token.

If your access token has expired, you can learn how to issue a new one without requiring users to reauthorize your application by reading the refresh token guide.Authorization Code with PKCE Flow
The authorization code flow with PKCE is the recommended authorization flow if you’re implementing authorization in a mobile app, single page web apps, or any other type of application where the client secret can’t be safely stored.

The implementation of the PKCE extension consists of the following steps:

Code Challenge generation from a Code Verifier.
Request authorization from the user and retrieve the authorization code.
Request an access token from the authorization code.
Finally, use the access token to make API calls.
Pre-requisites
This guide assumes that:

You have read the authorization guide.
You have created an app following the apps guide.
Example
You can find an example app implementing Authorization Code flow with PKCE extension on GitHub in the web-api-examples repository.

Code Verifier
The PKCE authorization flow starts with the creation of a code verifier. According to the PKCE standard, a code verifier is a high-entropy cryptographic random string with a length between 43 and 128 characters (the longer the better). It can contain letters, digits, underscores, periods, hyphens, or tildes.

The code verifier could be implemented using the following JavaScript function:

const generateRandomString = (length) => {
const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const values = crypto.getRandomValues(new Uint8Array(length));
return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

const codeVerifier = generateRandomString(64);

Code Challenge
Once the code verifier has been generated, we must transform (hash) it using the SHA256 algorithm. This is the value that will be sent within the user authorization request.

Let's use window.crypto.subtle.digest to generate the value using the SHA256 algorithm from the given data:

const sha256 = async (plain) => {
const encoder = new TextEncoder()
const data = encoder.encode(plain)
return window.crypto.subtle.digest('SHA-256', data)
}

Next, we will implement a function base64encode that returns the base64 representation of the digest we just calculated with the sha256 function:

const base64encode = (input) => {
return btoa(String.fromCharCode(...new Uint8Array(input)))
.replace(/=/g, '')
.replace(/\+/g, '-')
.replace(/\//g, '\_');
}

Let's put all the pieces together to implement the code challenge generation:

const hashed = await sha256(codeVerifier)
const codeChallenge = base64encode(hashed);

Request User Authorization
To request authorization from the user, a GET request must be made to the /authorize endpoint. This request should include the same parameters as the authorization code flow, along with two additional parameters: code_challenge and code_challenge_method:

Query Parameter Relevance Value
client_id Required The Client ID generated after registering your application.
response_type Required Set to code.
redirect_uri Required The URI to redirect to after the user grants or denies permission. This URI needs to have been entered in the Redirect URI allowlist that you specified when you registered your application (See the app guide). The value of redirect_uri here must exactly match one of the values you entered when you registered your application, including upper or lowercase, terminating slashes, and such.
state Optional, but strongly recommended This provides protection against attacks such as cross-site request forgery. See RFC-6749.
scope Optional A space-separated list of scopes. If no scopes are specified, authorization will be granted only to access publicly available information: that is, only information normally visible in the Spotify desktop, web, and mobile players.
code_challenge_method Required Set to S256.
code_challenge Required Set to the code challenge that your app calculated in the previous step.
The code for requesting user authorization looks as follows:

const clientId = 'YOUR_CLIENT_ID';
const redirectUri = 'http://127.0.0.1:8080';

const scope = 'user-read-private user-read-email';
const authUrl = new URL("https://accounts.spotify.com/authorize")

// generated in the previous step
window.localStorage.setItem('code_verifier', codeVerifier);

const params = {
response_type: 'code',
client_id: clientId,
scope,
code_challenge_method: 'S256',
code_challenge: codeChallenge,
redirect_uri: redirectUri,
}

authUrl.search = new URLSearchParams(params).toString();
window.location.href = authUrl.toString();

The app generates a PKCE code challenge and redirects to the Spotify authorization server login page by updating the window.location object value. This allows the user to grant permissions to our application

Please note that the code verifier value is stored locally using the localStorage JavaScript property for use in the next step of the authorization flow.

Response
If the user accepts the requested permissions, the OAuth service redirects the user back to the URL specified in the redirect_uri field. This callback contains two query parameters within the URL:

Query Parameter Value
code An authorization code that can be exchanged for an access token.
state The value of the state parameter supplied in the request.
We must then parse the URL to retrieve the code parameter:

const urlParams = new URLSearchParams(window.location.search);
let code = urlParams.get('code');

The code will be necessary to request the access token in the next step.

If the user does not accept your request or if an error has occurred, the response query string contains the following parameters:

Query Parameter Value
error The reason authorization failed, for example: "access_denied"
state The value of the state parameter supplied in the request.
Request an access token
After the user accepts the authorization request of the previous step, we can exchange the authorization code for an access token. We must send a POST request to the /api/token endpoint with the following parameters:

Body Parameters Relevance Value
grant_type Required This field must contain the value authorization_code.
code Required The authorization code returned from the previous request.
redirect_uri Required This parameter is used for validation only (there is no actual redirection). The value of this parameter must exactly match the value of redirect_uri supplied when requesting the authorization code.
client_id Required The client ID for your app, available from the developer dashboard.
code_verifier Required The value of this parameter must match the value of the code_verifier that your app generated in the previous step.
The request must include the following HTTP header:

Header Parameter Relevance Value
Content-Type Required Set to application/x-www-form-urlencoded.
The request of the token could be implemented with the following JavaScript function:

const getToken = async code => {

// stored in the previous step
const codeVerifier = localStorage.getItem('code_verifier');

const url = "https://accounts.spotify.com/api/token";
const payload = {
method: 'POST',
headers: {
'Content-Type': 'application/x-www-form-urlencoded',
},
body: new URLSearchParams({
client_id: clientId,
grant_type: 'authorization_code',
code,
redirect_uri: redirectUri,
code_verifier: codeVerifier,
}),
}

const body = await fetch(url, payload);
const response = await body.json();

localStorage.setItem('access_token', response.access_token);
}

Response
On success, the response will have a 200 OK status and the following JSON data in the response body:

key Type Description
access_token string An access token that can be provided in subsequent calls, for example to Spotify Web API services.
token_type string How the access token may be used: always "Bearer".
scope string A space-separated list of scopes which have been granted for this access_token
expires_in int The time period (in seconds) for which the access token is valid.
refresh_token string See refreshing tokens.
What's next?
Great! We have the access token. Now you might be wondering: what do I do with it? Take a look at to the access token guide to learn how to make an API call using your new fresh access token.

If your access token has expired, you can learn how to issue a new one without requiring users to reauthorize your application by reading the refresh token guide.

Footer
Documentation
Web API
Web Playback SDK
Ads API
iOS
Android
Embeds
Commercial Hardware
Guidelines
Design
Accessibility
Community
News
Forum
Client Credentials Flow
The Client Credentials flow is used in server-to-server authentication. Since this flow does not include authorization, only endpoints that do not access user information can be accessed.

The following diagram shows how the Client Credentials Flow works:

Client Credentials Flow

Pre-requisites
This guide assumes that:

You have read the authorization guide.
You have created an app following the app guide.
Source Code
You can find an example app implementing Client Credentials flow on GitHub in the web-api-examples repository.

Request authorization
The first step is to send a POST request to the /api/token endpoint of the Spotify OAuth 2.0 Service with the following parameters encoded in application/x-www-form-urlencoded:

Body Parameters Relevance Value
grant_type Required Set it to client_credentials.
The headers of the request must contain the following parameters:

Header Parameter Relevance Value
Authorization Required Base 64 encoded string that contains the client ID and client secret key. The field must have the format: Authorization: Basic <base64 encoded client_id:client_secret>
Content-Type Required Set to application/x-www-form-urlencoded.
The following JavaScript creates and sends an authorization request:

var client_id = 'CLIENT_ID';
var client_secret = 'CLIENT_SECRET';

var authOptions = {
url: 'https://accounts.spotify.com/api/token',
headers: {
'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64'))
},
form: {
grant_type: 'client_credentials'
},
json: true
};

request.post(authOptions, function(error, response, body) {
if (!error && response.statusCode === 200) {
var token = body.access_token;
}
});

Response
If everything goes well, you'll receive a response with a 200 OK status and the following JSON data in the response body:

key Type Description
access_token string An access token that can be provided in subsequent calls, for example to Spotify Web API services.
token_type string How the access token may be used: always "Bearer".
expires_in int The time period (in seconds) for which the access token is valid.
For example:

```json
{
  "access_token": "NgCXRKc...MzYjw",
  "token_type": "bearer",
  "expires_in": 3600
}
```

What's next?
Learn how to use an access token to fetch data from the Spotify Web API by reading the access token guide.Refreshing tokens
A refresh token is a security credential that allows client applications to obtain new access tokens without requiring users to reauthorize the application.

Access tokens are intentionally configured to have a limited lifespan (1 hour), at the end of which, new tokens can be obtained by providing the original refresh token acquired during the authorization token request response:

```json
{
  "access_token": "NgCXRK...MzYjw",
  "token_type": "Bearer",
  "scope": "user-read-private user-read-email",
  "expires_in": 3600,
  "refresh_token": "NgAagA...Um_SHo"
}
```

Request
To refresh an access token, we must send a POST request with the following parameters:

Body Parameter Relevance Value
grant_type Required Set it to refresh_token.
refresh_token Required The refresh token returned from the authorization token request.
client_id Only required for the PKCE extension The client ID for your app, available from the developer dashboard.
And the following headers:

Header Parameter Relevance Value
Content-Type Required Always set to application/x-www-form-urlencoded.
Authorization Only required for the Authorization Code Base 64 encoded string that contains the client ID and client secret key. The field must have the format: Authorization: Basic <base64 encoded client_id:client_secret>
Example
The following code snippets represent two examples:

A client side (browser) JavaScript function to refresh tokens issued following the Authorization Code with PKCE extension flow.
A server side (nodeJS with express) Javascript method to refresh tokens issued under the Authorization Code flow.
browser
nodeJS

const getRefreshToken = async () => {

// refresh token that has been previously stored
const refreshToken = localStorage.getItem('refresh_token');
const url = "https://accounts.spotify.com/api/token";

    const payload = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      }),
    }
    const body = await fetch(url, payload);
    const response = await body.json();

    localStorage.setItem('access_token', response.access_token);
    if (response.refresh_token) {
      localStorage.setItem('refresh_token', response.refresh_token);
    }

}
Response
If everything goes well, you'll receive a 200 OK response which is very similar to the response when issuing an access token:

```json
{
access_token: 'BQBLuPRYBQ...BP8stIv5xr-Iwaf4l8eg',
token_type: 'Bearer',
expires_in: 3600,
refresh_token: 'AQAQfyEFmJJuCvAFh...cG_m-2KTgNDaDMQqjrOa3',
scope: 'user-read-email user-read-private'
}Search for Item

OAuth 2.0
Get Spotify catalog information about albums, artists, playlists, tracks, shows, episodes or audiobooks that match a keyword string. Audiobooks are only available within the US, UK, Canada, Ireland, New Zealand and Australia markets.

Important policy note
Spotify content may not be used to train machine learning or AI model
Request

GET
/search
q
string
Required
Your search query.

You can narrow down your search using field filters. The available filters are album, artist, track, year, upc, tag:hipster, tag:new, isrc, and genre. Each field filter only applies to certain result types.

The artist and year filters can be used while searching albums, artists and tracks. You can filter on a single year or a range (e.g. 1955-1960).
The album filter can be used while searching albums and tracks.
The genre filter can be used while searching artists and tracks.
The isrc and track filters can be used while searching tracks.
The upc, tag:new and tag:hipster filters can only be used while searching albums. The tag:new filter will return albums released in the past two weeks and tag:hipster can be used to return only albums with the lowest 10% popularity.

Example: q=remaster%2520track%3ADoxy%2520artist%3AMiles%2520Davis
type
array of strings
Required
A comma-separated list of item types to search across. Search results include hits from all the specified item types. For example: q=abacab&type=album,track returns both albums and tracks matching "abacab".

Allowed values: "album", "artist", "playlist", "track", "show", "episode", "audiobook"
market
string
An ISO 3166-1 alpha-2 country code. If a country code is specified, only content that is available in that market will be returned.
If a valid user access token is specified in the request header, the country associated with the user account will take priority over this parameter.
Note: If neither market or user country are provided, the content is considered unavailable for the client.
Users can view the country that is associated with their account in the account settings.

Example: market=ES
limit
integer
The maximum number of results to return in each item type.

Default: limit=20
Range: 0 - 50
Example: limit=10
offset
integer
The index of the first result to return. Use with limit to get the next page of search results.

Default: offset=0
Range: 0 - 1000
Example: offset=5
include_external
string
If include_external=audio is specified it signals that the client can play externally hosted audio content, and marks the content as playable in the response. By default externally hosted audio content is marked as unplayable in the response.

Allowed values: "audio"
Response
200
401
403
429
Search response

tracks
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of TrackObject
Required

artists
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of ArtistObject
Required

albums
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedAlbumObject
Required

playlists
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedPlaylistObject
Required

shows
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedShowObject
Required

episodes
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedEpisodeObject
Required

audiobooks
object
href
string
Required
A link to the Web API endpoint returning the full result of the request

Example: "https://api.spotify.com/v1/me/shows?offset=0&limit=20"
limit
integer
Required
The maximum number of items in the response (as set in the query or by default).

Example: 20
next
string
Required
Nullable
URL to the next page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
offset
integer
Required
The offset of the items returned (as set in the query or by default)

Example: 0
previous
string
Required
Nullable
URL to the previous page of items. ( null if none)

Example: "https://api.spotify.com/v1/me/shows?offset=1&limit=1"
total
integer
Required
The total number of items available to return.

Example: 4

items
array of SimplifiedAudiobookObject
Required
endpoint
https://api.spotify.com/v1/search
q
remaster%20track:Doxy%20artist:Miles%20Davis
type
album
market
ES
limit
10
offset
5
include_external
Request sample

cURL

Wget

HTTPie
curl --request GET \
 --url 'https://api.spotify.com/v1/search?q=remaster%2520track%3ADoxy%2520artist%3AMiles%2520Davis&type=album' \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
Response sample
{
"tracks": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [
{
"album": {
"album_type": "compilation",
"total_tracks": 9,
"available_markets": ["CA", "BR", "IT"],
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "2up3OPMp9Tb4dAKM2erWXQ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"release_date": "1981-12",
"release_date_precision": "year",
"restrictions": {
"reason": "market"
},
"type": "album",
"uri": "spotify:album:2up3OPMp9Tb4dAKM2erWXQ",
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
]
},
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
],
"available_markets": ["string"],
"disc_number": 0,
"duration_ms": 0,
"explicit": false,
"external_ids": {
"isrc": "string",
"ean": "string",
"upc": "string"
},
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"is_playable": false,
"linked_from": {
},
"restrictions": {
"reason": "string"
},
"name": "string",
"popularity": 0,
"preview_url": "string",
"track_number": 0,
"type": "track",
"uri": "string",
"is_local": false
}
]
},
"artists": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"followers": {
"href": "string",
"total": 0
},
"genres": ["Prog rock", "Grunge"],
"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"popularity": 0,
"type": "artist",
"uri": "string"
}
]
},
"albums": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"album_type": "compilation",
"total_tracks": 9,
"available_markets": ["CA", "BR", "IT"],
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "2up3OPMp9Tb4dAKM2erWXQ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"release_date": "1981-12",
"release_date_precision": "year",
"restrictions": {
"reason": "market"
},
"type": "album",
"uri": "spotify:album:2up3OPMp9Tb4dAKM2erWXQ",
"artists": [

```json
{
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"name": "string",
"type": "artist",
"uri": "string"
}
]
}
]
},
"playlists": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"collaborative": false,
"description": "string",
"external_urls": {
"spotify": "string"
},
```

"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"name": "string",
"owner": {
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"type": "user",
"uri": "string",
"display_name": "string"
},
"public": false,
"snapshot_id": "string",
"tracks": {
"href": "string",
"total": 0
},
"type": "string",
"uri": "string"
}
]
},
"shows": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"available_markets": ["string"],
"copyrights": [
{
"text": "string",
"type": "string"
}
```

],
"description": "string",
"html_description": "string",
"explicit": false,
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"is_externally_hosted": false,
"languages": ["string"],
"media_type": "string",
"name": "string",
"publisher": "string",
"type": "show",
"uri": "string",
"total_episodes": 0
}
]
},
"episodes": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"audio_preview_url": "https://p.scdn.co/mp3-preview/2f37da1d4221f40b9d1a98cd191f4d6f1646ad17",
"description": "A Spotify podcast sharing fresh insights on important topics of the moment—in a way only Spotify can. You’ll hear from experts in the music, podcast and tech industries as we discover and uncover stories about our work and the world around us.",
"html_description": "<p>A Spotify podcast sharing fresh insights on important topics of the moment—in a way only Spotify can. You’ll hear from experts in the music, podcast and tech industries as we discover and uncover stories about our work and the world around us.</p>",
"duration_ms": 1686230,
"explicit": false,
"external_urls": {
"spotify": "string"
},
```

"href": "https://api.spotify.com/v1/episodes/5Xt5DXGzch68nYYamXrNxZ",
"id": "5Xt5DXGzch68nYYamXrNxZ",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"is_externally_hosted": false,
"is_playable": false,
"language": "en",
"languages": ["fr", "en"],
"name": "Starting Your Own Podcast: Tips, Tricks, and Advice From Anchor Creators",
"release_date": "1981-12-15",
"release_date_precision": "day",
"resume_point": {
"fully_played": false,
"resume_position_ms": 0
},
"type": "episode",
"uri": "spotify:episode:0zLhl3WsOCQHbe1BPTiHgr",
"restrictions": {
"reason": "string"
}
}
]
},
"audiobooks": {
"href": "https://api.spotify.com/v1/me/shows?offset=0&limit=20",
"limit": 20,
"next": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"offset": 0,
"previous": "https://api.spotify.com/v1/me/shows?offset=1&limit=1",
"total": 4,
"items": [

```json
{
"authors": [
{
"name": "string"
}
```

],
"available_markets": ["string"],
"copyrights": [

```json
{
  "text": "string",
  "type": "string"
}
```

],
"description": "string",
"html_description": "string",
"edition": "Unabridged",
"explicit": false,
"external_urls": {
"spotify": "string"
},
"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"languages": ["string"],
"media_type": "string",
"name": "string",
"narrators": [

```json
{
  "name": "string"
}
```

],
"publisher": "string",
"type": "audiobook",
"uri": "string",
"total_chapters": 0
}
]
}
Web API •
References / Users / Get Current User's Profile
Get Current User's Profile

OAuth 2.0
Get detailed profile information about the current user (including the current user's username).

Authorization scopes
user-read-private
user-read-email
Request
GET
/me
Response
200
401
403
429
A user

country
string
The country of the user, as set in the user's account profile. An ISO 3166-1 alpha-2 country code. This field is only available when the current user has granted access to the user-read-private scope.

display_name
string
The name displayed on the user's profile. null if not available.

email
string
The user's email address, as entered by the user when creating their account. Important! This email address is unverified; there is no proof that it actually belongs to the user. This field is only available when the current user has granted access to the user-read-email scope.

explicit_content
object
The user's explicit content settings. This field is only available when the current user has granted access to the user-read-private scope.

filter_enabled
boolean
When true, indicates that explicit content should not be played.

filter_locked
boolean
When true, indicates that the explicit content setting is locked and can't be changed by the user.

external_urls
object
Known external URLs for this user.

spotify
string
The Spotify URL for the object.

followers
object
Information about the followers of the user.

href
string
Nullable
This will always be set to null, as the Web API does not support it at the moment.

total
integer
The total number of followers.

href
string
A link to the Web API endpoint for this user.

id
string
The Spotify user ID for the user.

images
array of ImageObject
The user's profile image.

url
string
Required
The source URL of the image.

Example: "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228"
height
integer
Required
Nullable
The image height in pixels.

Example: 300
width
integer
Required
Nullable
The image width in pixels.

Example: 300
product
string
The user's Spotify subscription level: "premium", "free", etc. (The subscription level "open" can be considered the same as "free".) This field is only available when the current user has granted access to the user-read-private scope.

type
string
The object type: "user"

uri
string
The Spotify URI for the user.

endpoint
https://api.spotify.com/v1/me
Request sample

cURL

Wget

HTTPie

```bash
curl --request GET \
 --url https://api.spotify.com/v1/me \
 --header 'Authorization: Bearer 1POdFZRZbvb...qqillRxMr2z'
```

Response sample

```json
{
"country": "string",
"display_name": "string",
"email": "string",
"explicit_content": {
"filter_enabled": false,
"filter_locked": false
},
```

"external_urls": {
"spotify": "string"
},
"followers": {
"href": "string",
"total": 0
},
"href": "string",
"id": "string",
"images": [

```json
{
  "url": "https://i.scdn.co/image/ab67616d00001e02ff9ca10b55ce82ae553c8228",
  "height": 300,
  "width": 300
}
```

],
"product": "string",
"type": "string",
"uri": "string"
}

import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  SignUpCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { setAccessToken } from './api';

const region = import.meta.env.VITE_AWS_REGION;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const cognito = region && clientId ? new CognitoIdentityProviderClient({ region }) : null;

const getClient = () => {
  if (!cognito || !clientId) {
    throw new Error('Cognito is not configured. Deploy the AWS stack and set VITE_AWS_REGION and VITE_COGNITO_CLIENT_ID.');
  }
  return cognito;
};

export async function signUp({ name, email, phone, password }) {
  await getClient().send(new SignUpCommand({
    ClientId: clientId,
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'name', Value: name },
      ...(phone ? [{ Name: 'phone_number', Value: phone }] : [])
    ]
  }));
}

export async function confirmSignUp(email, code) {
  await getClient().send(new ConfirmSignUpCommand({ ClientId: clientId, Username: email, ConfirmationCode: code }));
}

export async function signIn(email, password) {
  const result = await getClient().send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password }
  }));
  if (!result.AuthenticationResult?.AccessToken) {
    throw new Error('Sign-in needs an additional challenge. Contact your administrator.');
  }
  const session = {
    accessToken: result.AuthenticationResult.AccessToken,
    idToken: result.AuthenticationResult.IdToken,
    refreshToken: result.AuthenticationResult.RefreshToken
  };
  setAccessToken(session.accessToken);
  return session;
}

export function signOut() {
  setAccessToken(null);
}

export async function requestPasswordReset(email) {
  await getClient().send(new ForgotPasswordCommand({ ClientId: clientId, Username: email }));
}

export async function resetPassword(email, code, password) {
  await getClient().send(new ConfirmForgotPasswordCommand({
    ClientId: clientId,
    Username: email,
    ConfirmationCode: code,
    Password: password
  }));
}

export function getTokenClaims(token) {
  if (!token) return {};
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    throw new Error('Cognito returned an invalid identity token. Sign in again.');
  }
}

const fs = require("fs").promises;
const path = require("path");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

//Variables declaration
let gmail; //for gmail
let myLabel; //for custom label
let initTime; //for maintaining the time of mail checked last
let userDetails; //for user details

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  //OAuth Credentials
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  });
  //Tokens for future use
  await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
  //checking if tokens exist
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

async function startApp(auth) {
  gmail = google.gmail({ version: "v1", auth });

  //Checking for custom created label
  const res = await gmail.users.labels.list({
    userId: "me"
  });
  const labels = res.data.labels;
  const l = labels.find((l) => l.name === "Custom_Label"); //label name is "Custom_Label"
  //If already exists
  if (l) {
    myLabel = l; //assigning for future use
  } else {
    //Else create new label
    const resLabel = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: "Custom_Label"
      }
    });
    myLabel = resLabel.data; //assigning for future use
  }
  //When we start the app, we want the check the incoming mails after starting the app
  //Not the already sent/received mails
  //So for this, I am using a variable to store the time of the last unread mail received just
  //after starting the app, so to send automated replies to only the new incoming mails
  const resMessages = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    q: "is:unread",
    maxResults: 1 //we need only the last unread message
  });
  const msgDetails = await gmail.users.messages.get({
    userId: "me",
    id: resMessages.data.messages[0].id
  });
  //Setting the initial time
  initTime = msgDetails.data.internalDate;

  //Setting user details
  const resUser = await gmail.users.getProfile({
    userId: "me"
  });
  userDetails = resUser.data;

  console.log("Service Started!");

  //For checking new messages and replying to them after a random interval of 45-120 seconds
  checkAndSendReply();
  setInterval(() => {
    checkAndSendReply();
  }, Math.floor(Math.random() * (120000 - 45000 + 1)) + 45000);
}

const checkAndSendReply = async () => {
  console.log("Checking for new mails...");
  const resMails = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    q: "is:unread"
  });
  //Used for updating initTime after each funtion run
  //Reduces complexity for checking all the previous emails
  let currentMax = initTime;

  for (const msg of resMails.data.messages) {
    const messageDetails = await gmail.users.messages.get({
      userId: "me",
      id: msg.id
    });
    currentMax = Math.max(currentMax, messageDetails.data.internalDate);
    if (messageDetails.data.internalDate <= initTime) break;
    let f = await checkForPrevReply(messageDetails.data.threadId);
    if (f) {
      await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          threadId: messageDetails.data.threadId,
          raw: Buffer.from(
            `To: ${
              messageDetails.data.payload.headers.find((h) => h.name === "From")
                .value
            }\n` +
              `Subject: RE:${
                messageDetails.data.payload.headers.find(
                  (h) => h.name === "Subject"
                ).value
              }\n\n` +
              `The user will reply ASAP.\n\nThis is an automated mail!`
          ).toString("base64")
        }
      });
      await gmail.users.threads.modify({
        userId: "me",
        id: messageDetails.data.threadId,
        requestBody: {
          addLabelIds: [myLabel.id]
        }
      });
      console.log("Label added and reply sent!");
    }
  }
  initTime = currentMax;
};

const checkForPrevReply = async (threadId) => {
  const resThreadMessages = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full"
  });
  for (const msg of resThreadMessages.data.messages) {
    let a = msg.payload.headers.find((h) => h.name === "From");
    if (a.value === userDetails.emailAddress) return false;
  }
  return true;
};

authorize().then(startApp).catch(console.error);

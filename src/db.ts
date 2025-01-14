import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import loginUserSchema from './schemas/loginUserSchema.js'
import userAvatarSchema from './schemas/userAvatarSchema.js'
import EventEmitter from "events";
import quarkSchema from "./schemas/quarkSchema.js";
import channelSchema from "./schemas/channelSchema.js";
import messageSchema from "./schemas/messageSchema.js";
import quarkOrderSchema from "./schemas/quarkOrderSchema.js";
import nicknameSchema from "./schemas/nicknameSchema.js";

const LOGINDB_URI : string | undefined = process.env.LOGINDB_URI
if (typeof LOGINDB_URI === "undefined") {
    console.error("\nNo login database uri specified, Exiting...");
    process.exit(2);
}
const LQDB_URI : string | undefined = process.env.LQDB_URI
if (typeof LQDB_URI === "undefined") {
    console.error("\nNo lightquark database uri specified, Exiting...");
    process.exit(3);
}

const dbEvents = new EventEmitter();
export default { dbEvents, getLoginUsers, getAvatars, getQuarks, getChannels, getMessages, getQuarkOrders, getNicks };

const logindb = mongoose.createConnection(LOGINDB_URI)

let LoginUsers
logindb.once("open", () => {
    LoginUsers = logindb.model('user', loginUserSchema)
    dbEvents.emit("login_ready");
})

const lqdb = mongoose.createConnection(LQDB_URI)

let Avatars
let Quarks
let Channels
let Messages
let QuarkOrders
let Nicks
lqdb.once("open", () => {
    Avatars = lqdb.model('avatar', userAvatarSchema)
    Quarks = lqdb.model('quark', quarkSchema)
    Channels = lqdb.model('channel', channelSchema)
    Messages = lqdb.model('message', messageSchema)
    QuarkOrders = lqdb.model('quarkOrder', quarkOrderSchema)
    Nicks = lqdb.model('nick', nicknameSchema)
    dbEvents.emit("lq_ready");
})

function getLoginUsers() {
    return LoginUsers;
}

function getAvatars() {
    return Avatars;
}

function getQuarks() {
    return Quarks;
}

function getChannels() {
    return Channels;
}

function getMessages() {
    return Messages;
}

function getQuarkOrders() {
    return QuarkOrders;
}

function getNicks() {
    return Nicks;
}
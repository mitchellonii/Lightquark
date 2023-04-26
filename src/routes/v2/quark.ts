import express, {Request, Response, Router} from 'express';
import Reply from "../../classes/reply/Reply.js";
import { Auth } from './auth.js';
import db from "../../db.js";
import * as mongoose from "mongoose";
import ServerErrorReply from "../../classes/reply/ServerErrorReply.js";
import InvalidReplyMessage from "../../classes/reply/InvalidReplyMessage.js";
import NotFoundReply from "../../classes/reply/NotFoundReply.js";
import {isUint8Array} from "util/types";
import {fileTypeFromBuffer, FileTypeResult} from "file-type";
import FormData from "form-data";
import fs from "fs";
import axios from "axios";
import {subscriptionListener} from "../v1/gateway.js";

const router: Router = express.Router();

/**
 * Get servers that the user is a member of.
 * Servers are called Quarks.
 */
router.get("/me", Auth, (req, res) => {
    let Quarks = db.getQuarks();
    Quarks.find({ members: res.locals.user._id}, async (err, quarks) => {
        if (err) return res.status(500).json(new Reply(500, false, {message: "An error occurred while fetching quarks"}));
        let Channels = db.getChannels();
        const resolveChannels = async (quarkChannels, quarkId) => {
            let channels = await Channels.find({ quark: quarkId })
            let newChannels = await Promise.all(quarkChannels.map((channel) => {
                let foundChannel = channels.find((c) => c._id.toString() === channel.toString());
                if (foundChannel) channel = foundChannel;
                return channel;
            }))
            return newChannels;
        }

        quarks = await Promise.all(quarks.map(async (quark) => {
            let inflatedChannels = await resolveChannels(quark.channels, quark._id);
            quark.channels = inflatedChannels;
            return quark;
        }))

        res.json(new Reply(200, true, {message: "Here are the quarks you are a member of", quarks}));
    })
});


/**
 * Change quark order
 * @param {string[]} order - The new order of the quarks
 */
router.put("/order", Auth, async (req, res) => {
    try {
        if (!req.body.order) return res.status(400).json(new InvalidReplyMessage("Provide an order"));
        let Quarks = db.getQuarks();
        let quarkIds = (await Quarks.find({members: res.locals.user._id})).map((quark) => quark._id.toString());

        // Make sure all quarks are in the order
        if (req.body.order.length !== quarkIds.length) return res.status(400).json(new InvalidReplyMessage("Invalid order"));
        for(let i = 0; i < quarkIds.length; i++) {
            if (!req.body.order.includes(quarkIds[i])) return res.status(400).json(new InvalidReplyMessage("Invalid order"));
        }

        // Update the order
        let QuarkOrder = db.getQuarkOrders();
        await QuarkOrder.updateOne({userId: res.locals.user._id}, {order: req.body.order}, {upsert: true});

        res.json(new Reply(200, true, {message: "Quark order updated"}));

        // Send update event
        let data = {
            eventId: "quarkOrderUpdate",
            order: req.body.order,
            userId: res.locals.user._id
        }
        subscriptionListener.emit("event", `me`, data);


    } catch (e) {
        console.error(e);
        return res.status(500).json(new ServerErrorReply());
    }
})

/**
 * Get quark order
 */
router.get("/order", Auth, async (req, res) => {
    try {
        let QuarkOrder = db.getQuarkOrders();
        let order = await QuarkOrder.findOne({userId: res.locals.user._id});
        if (!order) {
            order = new QuarkOrder({
                userId: res.locals.user._id,
                order: [],
                _id: new mongoose.Types.ObjectId()
            })

            let Quarks = db.getQuarks();
            let quarks = await Quarks.find({members: res.locals.user._id});
            order.order = quarks.map((quark) => quark._id.toString());

            await order.save();
        } else {
            let Quarks = db.getQuarks();
            let quarks = await Quarks.find({members: res.locals.user._id});

            quarks.forEach(quark => {
                if (!order.order.includes(quark._id.toString())) {
                    order.order.push(quark._id.toString());
                }
            })
            order.order.forEach(quarkId => {
                if (!quarks.find((quark) => quark._id.toString() === quarkId)) {
                    order.order.splice(order.order.indexOf(quarkId), 1);
                }
            })
            await order.save();

        }

        res.json(new Reply(200, true, {order: order.order}));
    } catch (e) {
        console.error(e);
        return res.status(500).json(new ServerErrorReply());
    }
})

/**
 * Create a new quark
 * @param name The name of the quark
 */
router.post("/create", Auth, (req, res) => {
    if (!req.body.name || !req.body.name.trim()) return res.json(new Reply(400, false, {message: "Name is required"}));
    if (req.body.name.length > 64) return res.json(new Reply(400, false, {message: "Name must be less than 64 characters"}));
    let Quark = db.getQuarks();
    let defaultChannelId = new mongoose.Types.ObjectId();
    let quarkId = new mongoose.Types.ObjectId();
    let newQuark = new Quark({
        _id: quarkId,
        members: [res.locals.user._id], // Add the user to the quark
        name: req.body.name.trim(), // Trim the name to remove any whitespace
        iconUri: "https://lq.litdevs.org/default.webp", // Use default icon
        emotes: [],
        roles: [],
        bans: [],
        channels: [defaultChannelId], // Add the default channel
        invite: `${req.body.name.replace(/[^A-Za-z0-9-_.]/g, "-").toLowerCase()}-${Math.floor(Math.random() * 1000000)}`, // Generate random invite code
        owners: [res.locals.user._id] // Add the user to the owners
    });
    newQuark.save((err, quark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        let Channel = db.getChannels();
        let newChannel = new Channel({
            _id: defaultChannelId,
            name: "general",
            quark: quark._id,
            description: "The default channel"
        })
        newChannel.save((err) => {
            if (err) {
                console.error(err);
                return res.status(500).json(new ServerErrorReply());
            }
            res.json(new Reply(200, true, {message: "Quark created", quark}));
        })
    })
})

router.post("/:id/leave", Auth, (req, res) => {
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));
    let Quark = db.getQuarks();
    Quark.findOne({_id: req.params.id, members: res.locals.user._id}, (err, quark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!quark) return res.status(404).json(new NotFoundReply("Quark not found"));
        if (quark.owners.includes(res.locals.user._id)) return res.status(400).json(new Reply(400, false, {message: "You cannot leave a quark you own"}));
        quark.members = quark.members.filter((member) => member.toString() !== res.locals.user._id.toString());
        quark.save((err) => {
            if (err) {
                console.error(err);
                return res.status(500).json(new ServerErrorReply());
            }
            res.json(new Reply(200, true, {message: "You have left the quark"}));

            // Send leave event
            let data = {
                eventId: "memberLeave",
                quark: quark,
                user: { _id: res.locals.user._id, username: res.locals.user.username, avatarUri: res.locals.user.avatar }
            }
            subscriptionListener.emit("event", `quark_${quark._id}` , data);
        })
    })
})

/**
 * Respond 400 if no quark id is provided
 */
router.all("/", Auth, (req, res) => {
    res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
})

/**
 * Delete a quark by id
 */
router.delete("/:id", Auth, (req, res) => {
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));
    let Quarks = db.getQuarks();
    Quarks.findOne({ _id: req.params.id, owners: res.locals.user._id }, (err, quark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!quark) return res.status(404).json(new NotFoundReply("Quark not found, or you are not an owner"));
        Quarks.deleteOne({ _id: quark._id, owners: res.locals.user._id }, (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json(new ServerErrorReply());
            }
            res.json(new Reply(200, true, {message: "Quark deleted"}));

            // Send delete event
            let data = {
                eventId: "quarkDelete",
                quark: quark
            }
            subscriptionListener.emit("event", `quark_${quark._id}` , data);
        })
    })
})

/**
 * Get a quark by id
 */
router.get("/:id", Auth, (req, res) => {
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));
    let Quarks = db.getQuarks();
    Quarks.findOne({ _id: req.params.id }, (err, quark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!quark) return res.status(404).json(new NotFoundReply("Quark not found"));
        let Channels = db.getChannels();
        Channels.find({ quark: quark._id }, (err, channels) => {
            if (err) {
                console.error(err);
                return res.status(500).json(new ServerErrorReply());
            }
            quark.channels = quark.channels.map((channel) => {
                let foundChannel = channels.find((c) => c._id.toString() === channel.toString());
                if (foundChannel) channel = foundChannel;
                return channel;
            })
            res.json(new Reply(200, true, {message: "Here is the quark", quark}));
        })
    })
})

/**
 * Get a quark by invite
 */
router.get("/invite/:invite", (req, res) => {
    if (!req.params.invite) return res.status(400).json(new InvalidReplyMessage("Invalid invite"));
    let Quarks = db.getQuarks();
    Quarks.findOne({ invite: req.params.invite }, (err, inviteQuark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!inviteQuark) return res.status(404).json(new NotFoundReply("Invalid invite"));
        res.json(new Reply(200, true, {message: "Invite valid!", quark: inviteQuark}));
    })
})

/**
 * Join a quark by invite
 */
router.post("/invite/:invite", Auth, (req, res) => {
    if (!req.params.invite) return res.status(400).json(new InvalidReplyMessage("Invalid invite"));
    let Quarks = db.getQuarks();
    Quarks.findOne({ invite: req.params.invite }, (err, inviteQuark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!inviteQuark) return res.status(404).json(new NotFoundReply("Invalid invite"));
        if (inviteQuark.members.includes(res.locals.user._id)) return res.status(400).json(new InvalidReplyMessage("You are already a member of this quark"));
        inviteQuark.members.push(res.locals.user._id);
        inviteQuark.save((err) => {
            if (err) {
                console.error(err);
                return res.status(500).json(new ServerErrorReply());
            }
            res.json(new Reply(200, true, {message: "Joined quark", quark: inviteQuark}));

            // Send update event
            let data = {
                eventId: "memberJoin",
                quark: inviteQuark,
                user: { _id: res.locals.user._id, username: res.locals.user.username, avatarUri: res.locals.user.avatar }
            }
            subscriptionListener.emit("event", `quark_${inviteQuark._id}` , data);
        });
    })
})

/**
 * Upload a quark icon
 */
router.put("/:id/icon", Auth, async (req, res) => {
    // Validate the quark id
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));
    // Validate the request body
    if (!req.body || !isUint8Array(req.body)) return res.json(new Reply(400, false, {message: "Request body must be an image file in binary form"}));
    let fileType : FileTypeResult | undefined = await fileTypeFromBuffer(req.body);
    if (!fileType) return res.json(new Reply(400, false, {message: "Request body must be an image file in binary form"}));

    let randomName = `${Math.floor(Math.random() * 1000000)}.${fileType.ext}`;
    let Quarks = db.getQuarks();
    // Find the quark
    Quarks.findOne({ _id: req.params.id, owners: res.locals.user._id }, (err, quark) => {
        if (!quark) return res.status(404).json(new NotFoundReply("Quark not found, or you are not an owner"));
        let formData = new FormData();
        // Write temp file
        fs.writeFileSync(`/share/wcloud/${randomName}`, req.body);
        formData.append("upload", fs.createReadStream(`/share/wcloud/${randomName}`));
        // Upload to Wanderer's Cloud
        formData.submit({host: "upload.wanderers.cloud", headers: {authentication: process.env.WC_TOKEN}}, (err, response) => {
            if (err) return res.json(new ServerErrorReply());
            response.resume()
            response.once("data", (data) => {
                let dataString = data.toString().trim();
                quark.iconUri = dataString;
                // Save changes
                quark.save((err) => {
                    if (err) return res.json(new ServerErrorReply());
                    res.json(new Reply(200, true, {message: "Quark icon has been updated", icon: dataString}));
                    // Send update event
                    let data = {
                        eventId: "quarkUpdate",
                        quark: quark
                    }
                    subscriptionListener.emit("event", `quark_${quark._id}` , data);
                })
            })
            response.once("end", () => {
                if (!fileType) return;
                // Delete temp file
                fs.unlinkSync(`/share/wcloud/${randomName}`);
            })
        })
    })
})


/**
 * Reset the quark icon to the default icon.
 */
router.delete("/:id/icon", Auth, (req, res) => {
    // Validate the quark id
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));

    // Find the quark and reset the icon
    let Quarks = db.getQuarks();
    Quarks.findOne({_id: req.params.id, owners: res.locals.user._id}, (err, quark) => {
        if (err) {
            console.error(err);
            return res.json(new ServerErrorReply());
        }
        if (!quark) return res.status(404).json(new InvalidReplyMessage("Quark not found or you are not an owner"));
        let oldIcon = quark.iconUri;
        if (quark.iconUri === "https://lq.litdevs.org/default.webp") return res.status(400).json(new InvalidReplyMessage("Quark already has the default icon"));
        quark.iconUri = "https://lq.litdevs.org/default.webp"; // Default icon
        quark.save((err) => {
            if (err) {
                console.error(err);
                return res.json(new ServerErrorReply());
            }
            axios.delete(`https://wanderers.cloud/file/${oldIcon.split("file/")[1].split(".")[0]}`, {headers: {authentication: process.env.WC_TOKEN}}).then((response) => {
                res.json(new Reply(200, true, {message: "Quark icon has been reset", icon: "https://lq.litdevs.org/default.webp"}));

                // Send update event
                let data = {
                    eventId: "quarkUpdate",
                    quark: quark
                }
                subscriptionListener.emit("event", `quark_${quark._id}` , data);
            })
        })
    })
})

/**
 * Edit a quark by id
 */
// TODO: Allow roles to edit quarks
router.patch("/:id", Auth, (req, res) => {
    if (!req.params.id) return res.status(400).json(new InvalidReplyMessage("Provide a quark id"));
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json(new InvalidReplyMessage("Invalid quark id"));
    let Quarks = db.getQuarks();
    Quarks.findOne({ _id: req.params.id }, (err, quark) => {
        if (err) {
            console.error(err);
            return res.status(500).json(new ServerErrorReply());
        }
        if (!quark) return res.status(404).json(new NotFoundReply("Quark not found"));
        if (!quark.owners.includes(res.locals.user._id)) return res.status(403).json(new Reply(403, false, {message: "You are not an owner of this quark"}));
        // Update name
        if (req.body.name) {
            if (req.body.name.length > 64) return res.status(400).json(new Reply(400, false, {message: "Name must be less than 64 characters"}));
            quark.name = req.body.name.trim();
        }
        // Update owner list
        if (req.body.owners) {
            if (!Array.isArray(req.body.owners)) return res.status(400).json(new Reply(400, false, {message: "Owners must be an array"}));
            if(req.body.owners.length < 1) return res.status(400).json(new Reply(400, false, {message:"There must be at least 1 owner"}))
            let stop = false;
            let erMsg = "";
            req.body.owners.forEach((owner) => {
                if (!stop) {
                    if (!mongoose.isValidObjectId(owner)) {
                        stop = true
                        return erMsg = `${owner} is not a valid user id`;
                    }
                    if (!quark.members.includes(owner)) {
                        stop = true;
                        return erMsg = `${owner} is not a member of this quark`;
                    }
                }
            })
            if (stop) return res.status(400).json(new InvalidReplyMessage(erMsg));
            quark.owners = req.body.owners;
        }
        const finishUpdate = () => {
            // Save the quark
            quark.save((err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json(new ServerErrorReply());
                }
                res.json(new Reply(200, true, {message: "Quark updated", quark}));

                // Send update event
                let data = {
                    eventId: "quarkUpdate",
                    quark: quark
                }
                subscriptionListener.emit("event", `quark_${quark._id}` , data);
            });
        }
        // Update invite
        if (req.body.invite && typeof req.body.invite === "string") {
            req.body.invite = req.body.invite.replace(/[^A-Za-z0-9-_.]/g, "-").toLowerCase();
            if (req.body.invite.trim().length > 16) return res.status(400).json(new Reply(400, false, {message: "Invite must be less than 16 characters"}));
            quark.invite = req.body.invite;
            Quarks.findOne({invite: req.body.invite}, (err, inviteQuark) => {
                if (err) {
                    console.error(err);
                    return res.status(500).json(new ServerErrorReply());
                }
                if (inviteQuark) return res.status(400).json(new InvalidReplyMessage("Invite already in use"));
                finishUpdate();
            })
        } else {
            finishUpdate();
        }
    })
})



export default router;

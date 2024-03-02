import express from 'express';
import fetch from 'node-fetch';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import dotenv from 'dotenv';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import admin from 'firebase-admin';

const app = express();
const firebaseConfig = {
  credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_KEY)),
  storageBucket: "codepulse-india.appspot.com"
};
const storage = admin.initializeApp(firebaseConfig).storage();

dotenv.config();

const dbURI = process.env.MONGODB_URI;
mongoose.connect(dbURI);

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
    console.log("Connected to MongoDB");
});

const userSchema = new mongoose.Schema({
    username: String,
    lastRequestTimestamp: Date,
    requestsMade: Number,
    userType: String
});

const User = mongoose.model('User', userSchema);

async function getProLLMResponse(prompt) {
    try {
        const seedBytes = randomBytes(4);
        const seed = seedBytes.readUInt32BE();

        const data = {
            width: 1024,
            height: 1024,
            seed: seed,
            num_images: 1,
            modelType: process.env.MODEL_TYPE,
            sampler: 9,
            cfg_scale: 3,
            guidance_scale: 3,
            strength: 1.7,
            steps: 30,
            high_noise_frac: 1,
            negativePrompt: 'ugly, deformed, noisy, blurry, distorted, out of focus, bad anatomy, extra limbs, poorly drawn face, poorly drawn hands, missing fingers',
            prompt: prompt,
            hide: false,
            isPrivate: false,
            batchId: '0yU1CQbVkr',
            generateVariants: false,
            initImageFromPlayground: false,
            statusUUID: process.env.STATUS_UUID
        };

        const response = await fetch(process.env.BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': process.env.COOKIES
            },
            body: JSON.stringify(data)
        });

        const json = await response.json();
        const imageUrl = `https://storage.googleapis.com/pai-images/${json.images[0].imageKey}.jpeg`;

        const imageResponse = await fetch(imageUrl);
        const buffer = await imageResponse.buffer();

        const tempFilePath = join(tmpdir(), `${Date.now()}.jpeg`);
        await fsPromises.writeFile(tempFilePath, buffer);

        // Upload image to Firebase Storage
        const bucket = storage.bucket();
        const firebaseFileName = `images/${Date.now()}.jpeg`;
        await bucket.file(firebaseFileName).save(buffer);

        // Generate public URL for the uploaded image
        const firebaseImageUrl = `https://storage.googleapis.com/${firebaseConfig.storageBucket}/${firebaseFileName}`;

        return firebaseImageUrl;
    } catch (error) {
        return { error: 'Internal server error. Please try again later.' };
    }
}

app.get('/', (req, res) => {
    res.send('Server is running');
});

app.get('/prompt', async (req, res) => {
    const prompt = req.query.prompt;
    const ipAddress = req.query.ip;

    if (!prompt || !ipAddress) {
        return res.status(400).json({ error: 'Both prompt and IP address are required.' });
    }

    try {
        let user = await User.findOne({ username: ipAddress });
        if (!user) {
            user = await User.create({ username: ipAddress, lastRequestTimestamp: Date.now(), requestsMade: 0, userType: 'free' });
        }

        const now = Date.now();
        const elapsedTime = now - user.lastRequestTimestamp;
        if (elapsedTime >= 24 * 60 * 60 * 1000) {
            user.requestsMade = 0;
        }

        if (user.userType === 'free' && user.requestsMade >= 3) {
            return res.status(403).json({ error: 'Daily limit exceeded for free users. Upgrade to pro for unlimited access.' });
        }

        user.requestsMade++;
        user.lastRequestTimestamp = now;
        await user.save();

        const imageUrl = await getProLLMResponse(prompt);
        if (imageUrl.error) {
            return res.status(500).json({ error: imageUrl.error });
        }

        res.status(200).json({ imageUrl: imageUrl }); // Sending imageUrl in 200 response
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

import express from 'express';
import { PrismaClient } from '@prisma/client';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const prisma = new PrismaClient();
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const router = express.Router();

// Configure multer with disk storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)){
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

async function parseResumeWithAPINinja(filePath) {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));

    const response = await axios({
      method: 'post',
      url: 'https://api.api-ninjas.com/v1/resumeparser',
      headers: {
        'X-Api-Key': 'qaDKkdnqEqXu2o8g/1JLGg==cQBuHfVVsQ7H0w20',
        'Content-Type': 'multipart/form-data'
      },
      data: form
    });

    return response.data;
  } catch (error) {
    console.error('Resume parsing error:', error.response?.data || error.message);
    throw new Error('Failed to parse resume');
  } finally {
    // Clean up: delete the temporary file
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Error deleting temporary file:', err);
    }
  }
}

router.get("/profile", async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      email: user.email,
      username: user.username,
      gender: user.gender,
      avatar_id: user.avatar_id,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post("/generate", upload.single('resume'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a resume file (PDF only)"
      });
    }

    console.log('Processing file:', file.originalname);

    // Read the PDF file content
    const fileContent = fs.readFileSync(file.path, 'utf8');

    // Single prompt for both parsing and question generation
    const prompt = `You are an expert resume analyzer and interview question generator.
    
Here's a resume:
${fileContent}

Analyze this resume and provide:
1. A summary of the candidate's profile
2. Key skills identified
3. Experience level assessment
4. 5 relevant interview questions

Return your response in this exact JSON format:
{
  "candidate_profile": {
    "experience_level": "entry/mid/senior",
    "key_skills": ["skill1", "skill2"],
    "primary_domain": "main field",
    "years_of_experience": "X years"
  },
  "interview_questions": [
    {
      "id": 1,
      "question": "detailed question",
      "expected_answer": "key points to look for",
      "difficulty": "easy/medium/hard",
      "type": "technical/behavioral",
      "skill_tested": "specific skill"
    }
  ]
}`;

    const result = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a resume analyzer and interview question generator. Return only valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: process.env.MODEL,
     
    });

    try {
      // Clean up the temporary file
      fs.unlinkSync(file.path);

      const cleanedResponse = result.choices[0].message.content.trim()
        .replace(/^```json\s*/, '')
        .replace(/```$/, '')
        .trim();

      const formattedResponse = JSON.parse(cleanedResponse);
      
      return res.json({
        success: true,
        data: formattedResponse
      });

    } catch (parseError) {
      return res.status(422).json({
        success: false,
        message: "Failed to process resume",
        error: parseError.message
      });
    }

  } catch (e) {
    console.error(e);
    // Clean up file in case of error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Error deleting file:', unlinkError);
      }
    }
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: e.message
    });
  }
});

export default router;
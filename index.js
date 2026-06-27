const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Promptrix Server is running!");
});

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

client
  .connect()
  .then(() => console.log("Connected to MongoDB"))
  .catch(console.dir);

const database = client.db("promptrix_db");

const promptCollection = database.collection("prompts");
const userCollection = database.collection("users");
const authUserCollection = database.collection("user");
const reviewCollection = database.collection("reviews");
const paymentCollection = database.collection("payments");
const bookmarkCollection = database.collection("bookmarks");
const reportCollection = database.collection("reports");
const sessionCollection = database.collection("session");

const toObjectId = (id) => new ObjectId(id);
const isValidObjectId = (id) => ObjectId.isValid(id);

const normalizeRole = (role = "") => role.toLowerCase();

const getPagination = (query) => {
  const page = Math.max(parseInt(query.page || "1", 10), 1);
  const perPage = Math.max(parseInt(query.perPage || "9", 10), 1);
  const skip = (page - 1) * perPage;

  return { page, perPage, skip };
};

const buildPromptQuery = (reqQuery) => {
  const query = {};

  // Public marketplace must only show approved visible prompts.
  if (reqQuery.publicOnly === "true") {
    query.isVisible = true;
    query.status = "approved";
  }

  if (reqQuery.status) {
    query.status = reqQuery.status;
  }

  if (reqQuery.creatorEmail) {
    query.creatorEmail = reqQuery.creatorEmail;
  }

  if (reqQuery.search) {
    query.$or = [
      { title: { $regex: reqQuery.search, $options: "i" } },
      { tags: { $regex: reqQuery.search, $options: "i" } },
      { aiTool: { $regex: reqQuery.search, $options: "i" } },
    ];
  }

  if (reqQuery.category) {
    query.category = reqQuery.category;
  }

  if (reqQuery.aiTool) {
    query.aiTool = reqQuery.aiTool;
  }

  if (reqQuery.difficulty) {
    query.difficulty = reqQuery.difficulty;
  }

  if (reqQuery.featured === "true") {
    query.featured = true;
  }

  return query;
};

const getPromptSort = (sort) => {
  if (sort === "most-copied") return { copyCount: -1 };
  return { createdAt: -1 };
};


// AUTH / ROLE MIDDLEWARE

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization;

    if (!authHeader) {
      return res.status(401).send({
        message: "unauthorized access: no authorization header",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).send({
        message: "unauthorized access: no token",
      });
    }

    const session = await sessionCollection.findOne({ token });

    if (!session) {
      return res.status(401).send({
        message: "unauthorized access: session not found",
        tokenPreview: token.slice(0, 12),
      });
    }

    const userId = session.userId;

    const authUser = await authUserCollection.findOne({
      $or: [
        { _id: userId },
        ...(ObjectId.isValid(userId) ? [{ _id: new ObjectId(userId) }] : []),
        { id: userId },
      ],
    });

    if (!authUser) {
      return res.status(401).send({
        message: "unauthorized access: auth user not found",
        userId,
      });
    }

    let appUser = await userCollection.findOne({
      email: authUser.email,
    });

    if (!appUser) {
      const newUser = {
        name: authUser.name || "User",
        email: authUser.email,
        image: authUser.image || "",
        role: "user",
        isPremium: false,
        subscription: "free",
        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newUser);

      appUser = {
        _id: result.insertedId,
        ...newUser,
      };
    }

    req.user = {
      ...authUser,
      ...appUser,
      email: appUser.email || authUser.email,
      name: appUser.name || authUser.name,
      role: appUser.role || "user",
      isPremium: appUser.isPremium || false,
      subscription: appUser.subscription || "free",
    };
     console.log(req.user)
    next();
  } catch (error) {
    return res.status(401).send({
      message: "unauthorized access",
      error: error.message,
    });
  }
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role?.toLowerCase() !== "admin") {
    return res.status(403).send({
      message: "forbidden access",
      email: req.user?.email,
      currentRole: req.user?.role,
    });
  }

  next();
};



app.get("/api/me", verifyToken, async (req, res) => {
  res.send({
    success: true,
    user: req.user,
  });
});

// PROMPTS


// Public route.

app.get("/api/prompts", async (req, res) => {
  try {
    const query = buildPromptQuery(req.query);
    const sortOption = getPromptSort(req.query.sort);

    // MongoDB aggregation feature
    if (req.query.sort === "most-popular") {
      const basePipeline = [
        { $match: query },
        {
          $lookup: {
            from: "reviews",
            let: { promptIdString: { $toString: "$_id" } },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$promptId", "$$promptIdString"],
                  },
                },
              },
            ],
            as: "reviews",
          },
        },
        {
          $addFields: {
            avgRating: { $ifNull: [{ $avg: "$reviews.rating" }, 0] },
            reviewCount: { $size: "$reviews" },
          },
        },
        {
          $sort: {
            avgRating: -1,
            reviewCount: -1,
            copyCount: -1,
            createdAt: -1,
          },
        },
      ];

      if (req.query.page) {
        const { page, perPage, skip } = getPagination(req.query);

        const totalResult = await promptCollection
          .aggregate([...basePipeline, { $count: "total" }])
          .toArray();

        const total = totalResult[0]?.total || 0;

        const prompts = await promptCollection
          .aggregate([...basePipeline, { $skip: skip }, { $limit: perPage }])
          .toArray();

        return res.send({
          total,
          page,
          perPage,
          totalPages: Math.ceil(total / perPage),
          prompts,
        });
      }

      if (req.query.limit) {
        basePipeline.push({ $limit: parseInt(req.query.limit, 10) });
      }

      const prompts = await promptCollection.aggregate(basePipeline).toArray();

      return res.send({
        total: prompts.length,
        prompts,
      });
    }

    // Normal pagination.
    if (req.query.page) {
      const { page, perPage, skip } = getPagination(req.query);

      const total = await promptCollection.countDocuments(query);

      const prompts = await promptCollection
        .find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(perPage)
        .toArray();

      return res.send({
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
        prompts,
      });
    }

    let cursor = promptCollection.find(query).sort(sortOption);

    if (req.query.limit) {
      cursor = cursor.limit(parseInt(req.query.limit, 10));
    }

    const prompts = await cursor.toArray();

    res.send({
      total: prompts.length,
      prompts,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch prompts",
      error: error.message,
    });
  }
});

// Public single prompt read.

app.get("/api/prompts/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidObjectId(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const result = await promptCollection.findOne({ _id: toObjectId(id) });
    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch prompt",
      error: error.message,
    });
  }
});

// Protected prompt creation.

app.post("/api/prompts", verifyToken, async (req, res) => {
  try {
    const prompt = req.body;
    const creatorEmail = req.user.email;

    if (!creatorEmail) {
      return res.status(400).send({
        success: false,
        message: "Creator email is required",
      });
    }

    const isPremium =
      req.user?.isPremium || req.user?.subscription === "premium";

    // Free users can create max 3 prompts.
    if (!isPremium) {
      const existingPromptCount = await promptCollection.countDocuments({
        creatorEmail,
      });

      if (existingPromptCount >= 3) {
        return res.status(403).send({
          success: false,
          message:
            "Free users can add only 3 prompts. Upgrade to Premium to add more.",
        });
      }
    }

    const newPrompt = {
      ...prompt,
      creatorEmail,
      creatorName: prompt.creatorName || req.user.name || req.user.email,
      copyCount: 0,
      status: "pending",
      isVisible: false,
      featured: false,
      rejectionFeedback: "",
      createdAt: new Date(),
    };

    const result = await promptCollection.insertOne(newPrompt);

    res.send({
      success: true,
      insertedId: result.insertedId,
      prompt: {
        _id: result.insertedId,
        ...newPrompt,
      },
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to create prompt",
      error: error.message,
    });
  }
});

// Protected prompt update.
// Creator can update own prompt, admin can update any.
// Any creator edit sends prompt back to pending and hidden.
app.patch("/api/prompts/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const updateData = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const prompt = await promptCollection.findOne({ _id: toObjectId(id) });

    if (!prompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }

    const isOwner = prompt.creatorEmail === req.user.email;
    const isAdmin = normalizeRole(req.user.role) === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    const safeUpdate = {
      ...updateData,
      updatedAt: new Date(),
    };

    // Creator edits must be reviewed again.
    if (!isAdmin) {
      safeUpdate.status = "pending";
      safeUpdate.isVisible = false;
      safeUpdate.rejectionFeedback = "";
    }

    delete safeUpdate._id;
    delete safeUpdate.creatorEmail;
    delete safeUpdate.copyCount;

    const result = await promptCollection.updateOne(
      { _id: toObjectId(id) },
      { $set: safeUpdate }
    );

    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to update prompt",
      error: error.message,
    });
  }
});

// Protected prompt delete.
// Creator can delete own prompt, admin can delete any.
app.delete("/api/prompts/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidObjectId(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const prompt = await promptCollection.findOne({ _id: toObjectId(id) });

    if (!prompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }

    const isOwner = prompt.creatorEmail === req.user.email;
    const isAdmin = normalizeRole(req.user.role) === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    const result = await promptCollection.deleteOne({ _id: toObjectId(id) });

    await bookmarkCollection.deleteMany({ promptId: id });
    await reviewCollection.deleteMany({ promptId: id });
    await reportCollection.deleteMany({ promptId: id });

    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to delete prompt",
      error: error.message,
    });
  }
});

app.patch("/api/prompts/:id/increment-copy", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    if (!isValidObjectId(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const result = await promptCollection.updateOne(
      { _id: toObjectId(id) },
      { $inc: { copyCount: 1 } }
    );

    res.send(result);
  } catch (error) {
    res.status(500).send({ error: "Failed to increment copy count" });
  }
});

// USERS
// Admin only: all users table.
app.get("/api/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const query = {};

    if (req.query.role) {
      query.role = req.query.role;
    }

    const result = await userCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
});


// Protected user profile fetch.
// User can fetch own profile. Admin can fetch anyone.
app.get("/api/users/:email", verifyToken, async (req, res) => {
  try {
    const email = req.params.email;
    const isAdmin = normalizeRole(req.user.role) === "admin";

    if (req.user.email !== email && !isAdmin) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const user = await userCollection.findOne({ email });
    res.send(user || {});
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch user",
      error: error.message,
    });
  }
});

// Admin only: change role.
app.patch("/api/users/:email/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const email = req.params.email;
    const { role } = req.body;

    if (!["user", "creator", "admin", "User", "Creator", "Admin"].includes(role)) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const result = await userCollection.updateOne(
      { email },
      { $set: { role } }
    );

    res.send(result);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to update role",
      error: error.message,
    });
  }
});

// STATS / AGGREGATION

app.get("/api/stats", async (req, res) => {
  try {
    const result = await promptCollection
      .aggregate([
        {
          $group: {
            _id: null,
            totalCopies: { $sum: "$copyCount" },
            totalPrompts: { $sum: 1 },
          },
        },
      ])
      .toArray();

    res.send(result[0] || { totalCopies: 0, totalPrompts: 0 });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to load stats",
      error: error.message,
    });
  }
});


















// PAYMENTS / SUBSCRIPTION









app.listen(port, () => {
  console.log(`Promptrix backend listening on port ${port}`);
});

module.exports = app;
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


// BOOKMARKS

app.get("/api/bookmarks", verifyToken, async (req, res) => {
  try {
    const query = {};
    const isAdmin = normalizeRole(req.user.role) === "admin";

    if (req.query.email && isAdmin) {
      query.userEmail = req.query.email;
    } else {
      query.userEmail = req.user.email;
    }

    const bookmarks = await bookmarkCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(bookmarks);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch bookmarks",
      error: error.message,
    });
  }
});

app.post("/api/bookmarks/toggle", verifyToken, async (req, res) => {
  try {
    const { promptId } = req.body;

    const query = {
      userEmail: req.user.email,
      promptId,
    };

    const existing = await bookmarkCollection.findOne(query);

    if (existing) {
      await bookmarkCollection.deleteOne({ _id: existing._id });

      return res.json({
        success: true,
        action: "removed",
        bookmarked: false,
      });
    }

    await bookmarkCollection.insertOne({
      userId: req.user._id?.toString() || req.user.id || null,
      userEmail: req.user.email,
      userName: req.user.name || null,
      promptId,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      action: "added",
      bookmarked: true,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to toggle bookmark",
      error: error.message,
    });
  }
});


// REVIEWS

app.get("/api/reviews", async (req, res) => {
  try {
    const { promptId, email } = req.query;
    const query = {};

    if (promptId) query.promptId = promptId;
    if (email) query.email = email;

    const reviews = await reviewCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(reviews);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch reviews",
      error: error.message,
    });
  }
});

app.post("/api/reviews", verifyToken, async (req, res) => {
  try {
    const review = {
      ...req.body,
      name: req.user.name || req.body.name,
      email: req.user.email,
      rating: Number(req.body.rating || 0),
      date: req.body.date || new Date().toISOString(),
      createdAt: new Date(),
    };

    const result = await reviewCollection.insertOne(review);

    res.json({
      success: true,
      review: {
        _id: result.insertedId,
        ...review,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to save review",
      error: error.message,
    });
  }
});


// REPORTS

// Admin only: view all reports.
app.get("/api/reports", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const reports = await reportCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.send(reports);
  } catch (error) {
    res.status(500).send({
      message: "Failed to load reports",
      error: error.message,
    });
  }
});

// Logged-in users can report prompts.
app.post("/api/reports", verifyToken, async (req, res) => {
  try {
    const report = {
      promptId: req.body.promptId,
      promptTitle: req.body.promptTitle,
      creatorEmail: req.body.creatorEmail,
      creatorName: req.body.creatorName,
      reporterEmail: req.user.email,
      reporterName: req.user.name || req.body.reporterName,
      reason: req.body.reason,
      description: req.body.description || "",
      status: "open",
      createdAt: new Date(),
    };

    const result = await reportCollection.insertOne(report);

    res.send({
      success: true,
      insertedId: result.insertedId,
      report,
    });
  } catch (error) {
    res.status(500).send({ error: "Failed to save report" });
  }
});


// PAYMENTS / SUBSCRIPTION

// Protected payments.
// Admin can see all. Normal users only see their own.
app.get("/api/payments", verifyToken,verifyAdmin, async (req, res) => {
  try {
    const query = {};
    const isAdmin = normalizeRole(req.user.role) === "admin";

    if (isAdmin && req.query.email) {
      query.email = req.query.email;
    }

    if (!isAdmin) {
      query.email = req.user.email;
    }

    const payments = await paymentCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(payments);
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to fetch payments",
      error: error.message,
    });
  }
});

// Payment success route can call this after Stripe success.
// It uses body email because Stripe success page sends verified checkout data from your frontend flow.
app.post("/api/subscriptions", async (req, res) => {
  try {
    const data = req.body;

    const subscriptionInfo = {
      email: data.email,
      name: data.name,
      isPremium: true,
      subscription: "premium",
      paymentIntentId: data.paymentIntentId,
      stripeSessionId: data.stripeSessionId,
      amount: data.amount,
      currency: data.currency || "usd",
      date: data.date || new Date().toISOString(),
      createdAt: new Date(),
    };

    await paymentCollection.insertOne(subscriptionInfo);

    const updateResult = await userCollection.updateOne(
      { email: data.email },
      {
        $set: {
          isPremium: true,
          subscription: "premium",
          premiumSince: new Date(),
        },
      },
      { upsert: true }
    );

    res.send({
      success: true,
      message: "Premium access activated",
      updateResult,
      subscription: subscriptionInfo,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to activate premium",
      error: error.message,
    });
  }
});


// ADMIN

app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [totalUsers, totalPrompts, totalReviews, promptStats] =
      await Promise.all([
        userCollection.countDocuments(),
        promptCollection.countDocuments(),
        reviewCollection.countDocuments(),
        promptCollection
          .aggregate([
            {
              $group: {
                _id: null,
                totalCopies: { $sum: "$copyCount" },
              },
            },
          ])
          .toArray(),
      ]);

    res.send({
      totalUsers,
      totalPrompts,
      totalReviews,
      totalCopies: promptStats[0]?.totalCopies || 0,
    });
  } catch (error) {
    res.status(500).send({
      message: "Failed to load admin stats",
      error: error.message,
    });
  }
});

// Admin approves/rejects/pends prompts.
// Approved prompts become visible. Rejected/pending prompts stay hidden.
app.patch(
  "/api/admin/prompts/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { status, rejectionFeedback } = req.body;

      if (!isValidObjectId(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid prompt id",
        });
      }

      if (!["approved", "rejected", "pending"].includes(status)) {
        return res.status(400).send({
          success: false,
          message: "Invalid prompt status",
        });
      }

      if (status === "rejected" && !rejectionFeedback?.trim()) {
        return res.status(400).send({
          success: false,
          message: "Rejection feedback is required",
        });
      }

      const updateDoc = {
        status,
        reviewedAt: new Date(),
        reviewedBy: req.user.email,
      };

      if (status === "approved") {
        updateDoc.isVisible = true;
        updateDoc.rejectionFeedback = "";
      }

      if (status === "rejected") {
        updateDoc.isVisible = false;
        updateDoc.rejectionFeedback = rejectionFeedback;
      }

      if (status === "pending") {
        updateDoc.isVisible = false;
      }

      const result = await promptCollection.updateOne(
        { _id: toObjectId(id) },
        { $set: updateDoc }
      );

      res.send({
        success: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    } catch (error) {
      res.status(500).send({
        success: false,
        message: "Failed to update prompt status",
        error: error.message,
      });
    }
  }
);

app.patch(
  "/api/admin/prompts/:id/feature",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { featured } = req.body;

      if (!isValidObjectId(id)) {
        return res.status(400).send({ message: "Invalid prompt id" });
      }

      const result = await promptCollection.updateOne(
        { _id: toObjectId(id) },
        { $set: { featured: Boolean(featured) } }
      );

      res.send({ success: true, result });
    } catch (error) {
      res.status(500).send({
        message: "Failed to feature prompt",
        error: error.message,
      });
    }
  }
);

app.delete(
  "/api/admin/prompts/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;

      if (!isValidObjectId(id)) {
        return res.status(400).send({ message: "Invalid prompt id" });
      }

      const promptResult = await promptCollection.deleteOne({
        _id: toObjectId(id),
      });

      await bookmarkCollection.deleteMany({ promptId: id });
      await reviewCollection.deleteMany({ promptId: id });
      await reportCollection.deleteMany({ promptId: id });

      res.send({
        success: true,
        result: promptResult,
      });
    } catch (error) {
      res.status(500).send({
        message: "Failed to delete prompt",
        error: error.message,
      });
    }
  }
);

app.delete(
  "/api/admin/users/:email",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const email = req.params.email;

      const result = await userCollection.deleteOne({ email });

      await promptCollection.deleteMany({ creatorEmail: email });
      await bookmarkCollection.deleteMany({ userEmail: email });
      await reviewCollection.deleteMany({ email });
      await paymentCollection.deleteMany({ email });
      await reportCollection.deleteMany({ reporterEmail: email });

      res.send({ success: true, result });
    } catch (error) {
      res.status(500).send({
        message: "Failed to delete user",
        error: error.message,
      });
    }
  }
);

app.patch(
  "/api/admin/reports/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const { status, adminNote } = req.body;

      if (!isValidObjectId(id)) {
        return res.status(400).send({ message: "Invalid report id" });
      }

      const result = await reportCollection.updateOne(
        { _id: toObjectId(id) },
        {
          $set: {
            status,
            adminNote: adminNote || "",
            reviewedAt: new Date(),
            reviewedBy: req.user.email,
          },
        }
      );

      res.send({ success: true, result });
    } catch (error) {
      res.status(500).send({
        message: "Failed to update report",
        error: error.message,
      });
    }
  }
);

app.listen(port, () => {
  console.log(`Promptrix backend listening on port ${port}`);
});

module.exports = app;
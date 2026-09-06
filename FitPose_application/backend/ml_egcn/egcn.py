import torch
import torch.nn as nn
import torch.nn.functional as F


# ============================================================
# FITPOSE - GRAPH CONVOLUTION
# ============================================================

class GraphConv(nn.Module):
    """
    Graph convolution layer for skeleton sequences.

    Input:
        x -> (B, C, T, V)

    B = batch size
    C = feature channels
    T = temporal frames
    V = number of joints
    """

    def __init__(self, in_channels, out_channels, adjacency):

        super().__init__()

        self.in_channels = in_channels
        self.out_channels = out_channels

        # ----------------------------------------------------
        # Fixed skeleton graph
        # ----------------------------------------------------

        self.register_buffer(
            "adjacency",
            adjacency.clone().float()
        )

        # ----------------------------------------------------
        # Learnable adaptive graph
        # ----------------------------------------------------

        self.adaptive_weight = nn.Parameter(
            torch.zeros_like(adjacency)
        )

        # ----------------------------------------------------
        # Feature transformation
        # ----------------------------------------------------

        self.conv = nn.Conv2d(
            in_channels,
            out_channels,
            kernel_size=1
        )

        self.bn = nn.BatchNorm2d(
            out_channels
        )

    def forward(self, x):

        # ----------------------------------------------------
        # Adaptive adjacency
        # ----------------------------------------------------

        A = (
            self.adjacency
            + self.adaptive_weight
        )

        # ----------------------------------------------------
        # Graph aggregation
        # ----------------------------------------------------

        x = torch.einsum(
            "bctv,vw->bctw",
            x,
            A
        )

        # ----------------------------------------------------
        # Feature transformation
        # ----------------------------------------------------

        x = self.conv(x)

        x = self.bn(x)

        return x


# ============================================================
# EGCN BLOCK
# ============================================================

class EGCNBlock(nn.Module):
    """
    Spatial graph convolution followed by
    temporal convolution.

    Input:
        (B, C, T, V)

    Output:
        (B, C_out, T, V)
    """

    def __init__(
        self,
        in_channels,
        out_channels,
        adjacency,
        temporal_kernel=9
    ):

        super().__init__()

        # ----------------------------------------------------
        # Spatial graph convolution
        # ----------------------------------------------------

        self.graph_conv = GraphConv(
            in_channels=in_channels,
            out_channels=out_channels,
            adjacency=adjacency
        )

        # ----------------------------------------------------
        # Temporal convolution
        # ----------------------------------------------------

        self.temporal_conv = nn.Conv2d(
            out_channels,
            out_channels,
            kernel_size=(
                temporal_kernel,
                1
            ),
            padding=(
                temporal_kernel // 2,
                0
            )
        )

        self.bn = nn.BatchNorm2d(
            out_channels
        )

        # ----------------------------------------------------
        # Residual connection
        # ----------------------------------------------------

        if in_channels == out_channels:

            self.residual = nn.Identity()

        else:

            self.residual = nn.Sequential(

                nn.Conv2d(
                    in_channels,
                    out_channels,
                    kernel_size=1
                ),

                nn.BatchNorm2d(
                    out_channels
                )
            )

    def forward(self, x):

        # Save residual
        residual = self.residual(x)

        # Spatial graph convolution
        x = self.graph_conv(x)

        x = F.relu(x)

        # Temporal convolution
        x = self.temporal_conv(x)

        x = self.bn(x)

        # Residual connection
        x = x + residual

        x = F.relu(x)

        return x


# ============================================================
# EGCN FEATURE BRANCH
# ============================================================

class EGCNBranch(nn.Module):
    """
    EGCN feature extraction branch.

    Used independently for:
        1. Position information
        2. Motion information
    """

    def __init__(
        self,
        in_channels,
        adjacency
    ):

        super().__init__()

        self.block1 = EGCNBlock(
            in_channels=in_channels,
            out_channels=32,
            adjacency=adjacency
        )

        self.block2 = EGCNBlock(
            in_channels=32,
            out_channels=64,
            adjacency=adjacency
        )

        self.block3 = EGCNBlock(
            in_channels=64,
            out_channels=64,
            adjacency=adjacency
        )

    def forward(self, x):

        x = self.block1(x)

        x = self.block2(x)

        x = self.block3(x)

        return x


# ============================================================
# FITPOSE MULTI-TASK EGCN
# ============================================================

class EGCN(nn.Module):
    """
    FitPose Multi-Task EGCN.

    The model performs TWO tasks simultaneously:

    --------------------------------------------------------
    TASK 1: EXERCISE RECOGNITION
    --------------------------------------------------------

    10 classes:

        0 -> A01 Deep Squat
        1 -> A02 Hurdle Step
        2 -> A03 Inline Lunge
        3 -> A04 Side Lunge
        4 -> A05 Sit to Stand
        5 -> A06 Standing Active Straight Leg Raise
        6 -> A07 Standing Shoulder Abduction
        7 -> A08 Standing Shoulder Extension
        8 -> A09 Standing Shoulder Internal-External Rotation
        9 -> A10 Standing Shoulder Scaption


    --------------------------------------------------------
    TASK 2: MOVEMENT CONDITION
    --------------------------------------------------------

    2 classes:

        0 -> C02 Incorrect
        1 -> C01 Correct


    --------------------------------------------------------
    INPUT
    --------------------------------------------------------

    x shape:

        (B, T, V, C)

    where:

        B = batch size
        T = 64 frames
        V = 22 joints
        C = 3 coordinates


    --------------------------------------------------------
    OUTPUT
    --------------------------------------------------------

    exercise_logits:

        (B, 10)

    condition_logits:

        (B, 2)
    """

    def __init__(
        self,
        adjacency,
        num_exercises=10,
        num_conditions=2
    ):

        super().__init__()

        # ----------------------------------------------------
        # Basic configuration
        # ----------------------------------------------------

        self.num_joints = adjacency.shape[0]

        self.num_exercises = num_exercises

        self.num_conditions = num_conditions

        # ----------------------------------------------------
        # POSITION BRANCH
        # ----------------------------------------------------

        self.position_branch = EGCNBranch(
            in_channels=3,
            adjacency=adjacency
        )

        # ----------------------------------------------------
        # MOTION BRANCH
        # ----------------------------------------------------

        self.motion_branch = EGCNBranch(
            in_channels=3,
            adjacency=adjacency
        )

        # ----------------------------------------------------
        # FEATURE SIZE
        # ----------------------------------------------------
        #
        # Position branch -> 64 features
        # Motion branch   -> 64 features
        #
        # Total = 128
        #
        # ----------------------------------------------------

        feature_size = 128

        # ----------------------------------------------------
        # Shared feature layer
        # ----------------------------------------------------

        self.shared_fc = nn.Sequential(

            nn.Linear(
                feature_size,
                128
            ),

            nn.ReLU(),

            nn.Dropout(
                0.3
            )
        )

        # ----------------------------------------------------
        # EXERCISE CLASSIFICATION HEAD
        # ----------------------------------------------------

        self.exercise_head = nn.Sequential(

            nn.Linear(
                128,
                64
            ),

            nn.ReLU(),

            nn.Dropout(
                0.2
            ),

            nn.Linear(
                64,
                num_exercises
            )
        )

        # ----------------------------------------------------
        # CONDITION CLASSIFICATION HEAD
        # ----------------------------------------------------

        self.condition_head = nn.Sequential(

            nn.Linear(
                128,
                64
            ),

            nn.ReLU(),

            nn.Dropout(
                0.2
            ),

            nn.Linear(
                64,
                num_conditions
            )
        )

    # ========================================================
    # FORWARD
    # ========================================================

    def forward(self, x):

        """
        Forward pass.

        Input:
            x = (B, T, V, C)

        Returns:
            exercise_logits = (B, 10)
            condition_logits = (B, 2)
        """

        # ----------------------------------------------------
        # Validate input
        # ----------------------------------------------------

        if x.ndim != 4:

            raise ValueError(
                f"Expected input with 4 dimensions, "
                f"got {x.shape}"
            )

        if x.shape[2] != self.num_joints:

            raise ValueError(
                f"Expected {self.num_joints} joints, "
                f"got {x.shape[2]}"
            )

        if x.shape[3] != 3:

            raise ValueError(
                f"Expected 3 coordinate channels, "
                f"got {x.shape[3]}"
            )

        # ----------------------------------------------------
        # POSITION BRANCH
        # ----------------------------------------------------
        #
        # Input:
        # (B,T,V,C)
        #
        # Convert to:
        # (B,C,T,V)
        #
        # ----------------------------------------------------

        position = x.permute(
            0,
            3,
            1,
            2
        )

        position_features = self.position_branch(
            position
        )

        # ----------------------------------------------------
        # MOTION BRANCH
        # ----------------------------------------------------
        #
        # Calculate frame-to-frame movement.
        #
        # ----------------------------------------------------

        motion = torch.zeros_like(x)

        motion[:, 1:] = (
            x[:, 1:]
            - x[:, :-1]
        )

        motion = motion.permute(
            0,
            3,
            1,
            2
        )

        motion_features = self.motion_branch(
            motion
        )

        # ----------------------------------------------------
        # FEATURE FUSION
        # ----------------------------------------------------

        features = torch.cat(
            [
                position_features,
                motion_features
            ],
            dim=1
        )

        # ----------------------------------------------------
        # GLOBAL AVERAGE POOLING
        # ----------------------------------------------------
        #
        # Average over:
        #
        # T = temporal dimension
        # V = joint dimension
        #
        # Result:
        #
        # (B,128)
        #
        # ----------------------------------------------------

        features = features.mean(
            dim=(2, 3)
        )

        # ----------------------------------------------------
        # SHARED FEATURE REPRESENTATION
        # ----------------------------------------------------

        shared_features = self.shared_fc(
            features
        )

        # ----------------------------------------------------
        # EXERCISE PREDICTION
        # ----------------------------------------------------

        exercise_logits = self.exercise_head(
            shared_features
        )

        # ----------------------------------------------------
        # CONDITION PREDICTION
        # ----------------------------------------------------

        condition_logits = self.condition_head(
            shared_features
        )

        # ----------------------------------------------------
        # RETURN BOTH TASKS
        # ----------------------------------------------------

        return (
            exercise_logits,
            condition_logits
        )
import cv2

from pose_detection import close_pose_detector, detect_and_analyze


def start_camera():
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Cannot open camera")
        close_pose_detector()
        return

    try:
        while True:
            success, frame = cap.read()
            if not success:
                print("Cannot read camera frame")
                break

            frame, _, analysis = detect_and_analyze(frame)
            cv2.putText(
                frame,
                f"Reps: {analysis['rep_count']} | {analysis['posture_status']}",
                (12, 32),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            cv2.imshow("FitPose AI Camera", frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()
        close_pose_detector()


if __name__ == "__main__":
    start_camera()

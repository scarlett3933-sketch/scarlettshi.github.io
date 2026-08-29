import * as THREE from 'three';

export class InvisoClient {
    constructor({
        positionScale = 0.1,
        sendRateHz = 30,
        logger = console,
    } = {}) {
        this.logger = logger;

        // --------------------------------------------------------
        // CONNECTION
        // --------------------------------------------------------

        this.socket = null;
this.connected = false;
this.bridgeReady = false;

        const wsProtocol =
            window.location.protocol === 'https:'
                ? 'wss:'
                : 'ws:';

        this.url =
            `${wsProtocol}//${window.location.host}/inviso-ws`;

        // --------------------------------------------------------
        // SEND RATE
        // --------------------------------------------------------

        this.sendInterval = 1000 / sendRateHz;
        this.lastSendTime = 0;

        // --------------------------------------------------------
        // LISTENER MAPPING
        // --------------------------------------------------------

        this.positionScale = positionScale;

        this.originPosition = new THREE.Vector3();
        this.originYaw = 0;
        this.calibrated = false;

        this.headPosition = new THREE.Vector3();
        this.headQuaternion = new THREE.Quaternion();

        this.headEuler =
            new THREE.Euler(0, 0, 0, 'YXZ');
    }

    // ============================================================
    // CONNECTION
    // ============================================================

    connect() {
        if (
            this.socket &&
            (
                this.socket.readyState === WebSocket.OPEN ||
                this.socket.readyState === WebSocket.CONNECTING
            )
        ) {
            return;
        }

        this.logger.log(
            '[Inviso] Connecting:',
            this.url,
        );
        this.bridgeReady = false;

        try {
            this.socket = new WebSocket(this.url);
        } catch (error) {
            this.logger.error(
                '[Inviso] WebSocket constructor failed:',
                error,
            );
            return;
        }

        this.socket.addEventListener('open', () => {
            this.connected = true;

            this.logger.log(
                '[Inviso] WebSocket CONNECTED',
            );
        });

        this.socket.addEventListener('close', (event) => {
    this.connected = false;
    this.bridgeReady = false;

            this.logger.warn(
                '[Inviso] WebSocket disconnected',
                event.code,
                event.reason || '',
            );
        });

        this.socket.addEventListener('error', (error) => {
            this.logger.error(
                '[Inviso] WebSocket error',
                error,
            );
        });

        this.socket.addEventListener('message', (event) => {
    try {
        const message = JSON.parse(event.data);

        this.logger.log(
            '[Inviso bridge]',
            message,
        );

        if (
            message?.type === 'bridgeStatus' &&
            message?.connected === true
        ) {
            this.bridgeReady = true;

            this.logger.log(
                '[Inviso] Bridge READY'
            );
        }

    } catch (_) {
        this.logger.log(
            '[Inviso bridge raw]',
            event.data,
        );
    }
});
    }
        // ============================================================
    // WAIT FOR REAL BRIDGE READY
    //
    // WebSocket open != bridge ready.
    //
    // We only continue once quest_bridge.js has sent:
    //
    // { type: 'bridgeStatus', connected: true }
    //
    // This prevents Michigan mode from reporting READY when the
    // WebSocket was merely created but the bridge is not usable.
    // ============================================================

    waitForBridgeReady(timeoutMs = 8000) {
        // bridgeStatus may already have arrived before this method
        // gets called, so always check current state first.
        if (this.connected && this.bridgeReady) {
            return Promise.resolve(true);
        }

        return new Promise((resolve, reject) => {
            const startedAt = performance.now();

            const timer = setInterval(() => {
                // REAL READY
                if (this.connected && this.bridgeReady) {
                    clearInterval(timer);

                    this.logger.log(
                        '[Inviso] Bridge readiness confirmed',
                    );

                    resolve(true);
                    return;
                }

                // TIMEOUT
                if (
                    performance.now() - startedAt >= timeoutMs
                ) {
                    clearInterval(timer);

                    reject(
                        new Error(
                            `Inviso bridge did not become ready within ${timeoutMs} ms`,
                        ),
                    );
                }
            }, 50);
        });
    }

    // ============================================================
    // CALIBRATION
    // ============================================================

    resetCalibration() {
        this.calibrated = false;
    }

    // ============================================================
    // QUEST HEAD -> INVISO LISTENER
    // ============================================================

    updateListener({
        renderer,
        camera,
        timeMs = performance.now(),
    }) {
        if (
            !this.connected ||
            !this.socket ||
            this.socket.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        if (!renderer.xr.isPresenting) {
            return;
        }

        if (
            timeMs - this.lastSendTime <
            this.sendInterval
        ) {
            return;
        }

        this.lastSendTime = timeMs;

        const xrCamera =
            renderer.xr.getCamera(camera);

        xrCamera.getWorldPosition(
            this.headPosition,
        );

        xrCamera.getWorldQuaternion(
            this.headQuaternion,
        );

        this.headEuler.setFromQuaternion(
            this.headQuaternion,
            'YXZ',
        );

        const currentYaw =
            this.headEuler.y;

        // First valid XR pose becomes Inviso origin.

        if (!this.calibrated) {
            this.originPosition.copy(
                this.headPosition,
            );

            this.originYaw = currentYaw;

            this.calibrated = true;

            this.logger.log(
                '[Inviso] Origin calibrated:',
                this.originPosition
                    .toArray()
                    .map((v) => v.toFixed(2)),
                this.originYaw.toFixed(3),
            );
        }

        const x =
            (
                this.headPosition.x -
                this.originPosition.x
            ) * this.positionScale;

        const z =
            (
                this.headPosition.z -
                this.originPosition.z
            ) * this.positionScale;

        let yaw =
            currentYaw - this.originYaw;

        // Normalize yaw to [-PI, PI].

        yaw =
            Math.atan2(
                Math.sin(yaw),
                Math.cos(yaw),
            );

        this.send({
            type: 'pose',

            x,
            y: 0,
            z,

            yaw,
            pitch: 0,
            roll: 0,
        });
    }

    // ============================================================
    // GENERIC MESSAGE
    // ============================================================

    send(message) {
        if (
            !this.socket ||
            this.socket.readyState !== WebSocket.OPEN
        ) {
            return false;
        }

        this.socket.send(
            JSON.stringify(message),
        );

        return true;
    }

    // ============================================================
    // SOUND OBJECT COMMANDS
    //
    // These are ready for the Michigan bridge once we connect
    // per-object OSC control.
    // ============================================================

    objectCommand(name, command, value) {
        const message = {
            type: 'objectCommand',
            name,
            command,
        };

        if (value !== undefined) {
            message.value = value;
        }

        return this.send(message);
    }

    play(name) {
        return this.objectCommand(
            name,
            'play',
        );
    }

    pause(name) {
        return this.objectCommand(
            name,
            'pause',
        );
    }

    reset(name) {
        return this.objectCommand(
            name,
            'reset',
        );
    }

    loop(name, enabled) {
        return this.objectCommand(
            name,
            'loop',
            enabled ? 1 : 0,
        );
    }
}


import Foundation

@MainActor
final class IpcClient {
    var onEvent: (([String: Any]) -> Void)?
    var onAudio: ((Data) -> Void)?
    var onDisconnect: ((Error?) -> Void)?

    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?

    var isConnected: Bool { socket != nil }

    func connect(port: Int, token: String) {
        disconnect()
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/ws")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        self.session = session
        self.socket = socket
        socket.resume()

        receiveTask = Task { [weak self, weak socket] in
            guard let self, let socket else { return }
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    switch message {
                    case .data(let data):
                        self.onAudio?(data)
                    case .string(let text):
                        guard
                            let data = text.data(using: .utf8),
                            let event = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                        else { continue }
                        self.onEvent?(event)
                    @unknown default:
                        continue
                    }
                }
            } catch {
                guard !Task.isCancelled else { return }
                self.onDisconnect?(error)
                self.disconnect()
            }
        }
        sendRequest(type: "state.get", payload: [:])
    }

    func sendRequest(type: String, payload: [String: Any]) {
        guard let socket else { return }
        let envelope: [String: Any] = [
            "version": 1,
            "id": UUID().uuidString.lowercased(),
            "type": type,
            "payload": payload,
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: envelope)
            guard let text = String(data: data, encoding: .utf8) else { return }
            socket.send(.string(text)) { [weak self] error in
                guard let error else { return }
                Task { @MainActor in self?.onDisconnect?(error) }
            }
        } catch {
            onDisconnect?(error)
        }
    }

    func sendAudio(_ data: Data) {
        socket?.send(.data(data)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.onDisconnect?(error) }
        }
    }

    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        session?.invalidateAndCancel()
        session = nil
    }
}

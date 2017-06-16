var http = require("http");

var WebSocket = require("ws");
var RTM = require("satori-sdk-js"); // TODO: Deprecated
var io = require("socket.io-client");

// Credentials file
var credentials = require("./credentials.json");

// Satori.com publish keys
var roleSecretKey = credentials.satori.secret;
var appkey = credentials.satori.key;

var endpoint = "wss://open-data.api.satori.com";
var role = "altcoins";
var channel = "altcoins";

var roleSecretProvider = RTM.roleSecretAuthProvider(role, roleSecretKey);

var rtm = new RTM(endpoint, appkey, {
    authProvider: roleSecretProvider,
});

var subscription = rtm.subscribe(channel, RTM.SubscriptionMode.SIMPLE);

var subscribed = false;
subscription.on("enter-subscribed", function() {
    if (!subscribed) {
        subscribed = true;
        connectBlockio();
        connectEthereum();
        connectDash();
    }
});

rtm.start();

function connectBlockio() {
    // For BTC, LTC and DOGE get events directly from block.io
    var subscribed = false;
    var ws = new WebSocket("wss://n.block.io/");
    ws.timeout = 5400;

    ws.on("message", function(msg) {
        try {
            msg = JSON.parse(msg);

            if (msg.type == "new-transactions" || msg.type == "new-blocks") {
                rtm.publish(channel, msg);
            }

            if (!subscribed && msg.status == "success") {
                subscribed = true;
                subscribeToNewTransactions(ws, "BTC"); // bitcoin
                subscribeToNewTransactions(ws, "DOGE"); // dogecoin
                subscribeToNewTransactions(ws, "LTC"); // litecoin
            }
        } catch (e) {
        }
    });
    ws.on("error", function(e) {
        console.log(e);
    });
    ws.on("close", connectBlockio);
}

function connectEthereum() { // TODO: WIP
    // For ETH, connect to a local geth node. Source code to compile: https://github.com/ethereum/go-ethereum
    // To enable WebSocket API launch with geth --ws --wsorigins "*"
    // Don't mind allowing wildcard origins as it will bind to localhost only

    var txSubid, headSubId, txid = 0, bid = 0;

    var ws = new WebSocket("ws://localhost:8546/");
    ws.timeout = 5400;
    ws.on("open", function() {
        ws.send(JSON.stringify({ "id": 1, "method": "eth_subscribe", "params": ["newPendingTransactions"] }));
        ws.send(JSON.stringify({ "id": 2, "method": "eth_subscribe", "params": ["newHeads", { "includeTransactions": true }] })); // Heads are blocks
    });
    ws.on("message", function(msg) {
        try {
            msg = JSON.parse(msg);
            // Messages with id are replies to requests
            if (msg.id == 1) {
                txSubid = msg.result; // Get the transaction subscription ID
            } else if (msg.id == 2) {
                headSubId = msg.result; // Get the block subscription ID
            } else if (msg.id >= 3) { // Above ID 2, they are request replies
                if (msg.id < 10000) { // Under 10000 they are transactions
                    msg = msg.result;
                    rtm.publish(channel, {
                        type: "new-transactions",
                        data: {
                            network: "ETH",
                            txid: msg.hash,
                            received_at: Math.floor(new Date() / 1000),
                            amount_received: msg.value,
                            // ETH
                            from: msg.from,
                            to: msg.to,
                            nonce: msg.nonce,
                            gas: msg.gas,
                            gasPrice: msg.gasPrice,
                        }
                    });
                } else { // Above 10000 they are blocks
                    msg = msg.result;
                    rtm.publish(channel, {
                        type: "new-blocks",
                        data: {
                            network: "ETH",
                            block_hash: msg.hash,
                            previous_block_hash: msg.parentHash,
                            block_no: msg.number,
                            time: msg.timestamp,
                            nonce: msg.nonce,
                            difficulty: msg.difficulty,
                            txs: msg.transactions,
                            // ETH data
                            miner: msg.miner,
                            stateRoot: msg.stateRoot,
                            txRoot: msg.transactionsRoot,
                            receiptsRoot: msg.receiptsRoot,
                            gasLimit: msg.gasLimit,
                            gasUsed: msg.gasUsed,
                            unclesHash: msg.sha3Uncles,
                            uncles: msg.uncles,
                            extra: msg.extraData
                        }
                    });
                }
            } else {
                if (msg.params.subscription == headSubId) {
                    bid = (bid++) % 1000000;
                    ws.send(JSON.stringify({ "id": 10000 + bid, "method": "eth_getBlockByNumber", "params": [msg.params.result.number, false] }));
                } else if (msg.params.subscription == txSubid) {
                    txid = (txid++) % 9000;
                    ws.send(JSON.stringify({ "id": 3 + txid, "method": "eth_getTransactionByHash", "params": [msg.params.result] }));
                }
            }
        } catch (e) {
        }
    });
    ws.on("error", function(e) {
        console.log(e);
    });
    ws.on("close", connectEthereum);
}

function connectDash() {
    // For DASH connect to masternode.io Insight API: https://github.com/dashpay/insight-api-dash
    // Uses socket.io instead of WebSocket, so no reconnect logic is needed
    // TODO: Run my own DASH node and Insights API and connect to it
    var socket = io("http://insight.masternode.io:3000/");
    socket.on("connect", function() {
        socket.emit("subscribe", "inv");
    });
    socket.on("tx", function(data) {
        // If a new transaction is received, request the data via HTTP API
        http.get("http://insight.masternode.io:3000/api/tx/" + data.txid, function(response) {
            var data = "";
            response.setEncoding("utf8");
            response.on("data", function(chunk) {
                data += chunk;
            });
            response.on("end", function() {
                try {
                    // Format the data according to block.io format
                    data = JSON.parse(data);
                    var inputs = [];
                    var outputs = [];
                    data.vin.forEach(function(vin) {
                        inputs.push({
                            previous_txid: vin.txid,
                            previous_output_no: vin.vout,
                            // type: "pubkeyhash" // TODO: Ask previous transaction for this data
                            address: vin.addr,
                            amount: vin.value,
                            script: vin.scriptSig.asm,
                            input_no: vin.n,
                            // DASH data
                            confirmed: vin.isConfirmed,
                            confirmations: vin.confirmations,
                            unconfirmedInput: vin.unconfirmedInput,
                            doubleSpentTxID: vin.doubleSpentTxID
                        });
                    });
                    data.vout.forEach(function(vout) {
                        inputs.push({
                            output_no: vout.n,
                            type: vout.scriptPubKey.type,
                            address: vout.scriptPubKey.addresses[0],
                            amount: vout.value,
                            script: vout.scriptPubKey.asm,
                        });
                    });
                    rtm.publish(channel, {
                        type: "new-transactions",
                        data: {
                            network: "DASH",
                            txid: data.txid,
                            received_at: Math.floor(new Date() / 1000),
                            network_fee: data.fees,
                            amount_received: data.valueIn,
                            inputs: inputs,
                            outputs: outputs
                        }
                    });
                } catch (e) {
                    // TODO: Request again
                }
            });
        });
    });
    socket.on("txlock", function(data) {
        // TODO: Discover what txlock is and implement it
    });
    socket.on("block", function(data) {
        http.get("http://insight.masternode.io:3000/api/block/" + data, function(response) {
            var data = "";
            response.setEncoding('utf8');
            response.on("data", function(chunk) {
                data += chunk;
            });
            response.on('end', function() {
                try {
                    // Format the data according to block.io format
                    data = JSON.parse(data);
                    rtm.publish(channel, {
                        type: "new-blocks",
                        data: {
                            network: "DASH",
                            block_hash: data.hash,
                            previous_block_hash: data.previousblockhash,
                            block_no: data.height,
                            confirmations: data.confirmations,
                            merkle_root: data.merkleroot,
                            time: data.time,
                            nonce: data.nonce,
                            difficulty: data.difficulty,
                            txs: data.tx,
                            // DASH data
                            cbvalue: data.cbvalue,
                            isMainChain: data.isMainChain,
                            version: data.version
                        }
                    });
                } catch (e) {
                    console.log(e);
                    // TODO: Request again
                }
            });
        });
    });
}

function subscribeToNewTransactions(ws, network) {
    ws.send(JSON.stringify({ 'type': 'new-transactions', 'network': network }));
    ws.send(JSON.stringify({ 'type': 'new-blocks', 'network': network }));
}
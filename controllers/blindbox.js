const Product = require('../models/product')
const Order = require('../models/order')
const PullLog = require('../models/pulllog')

// pick a rarity tier by its configured odds, then a random collectible inside that tier
const chooseWeightedRarity = (box, candidates) => {
    const byRarity = new Map();
    for (const candidate of candidates) {
        const entries = byRarity.get(candidate.rarity) || [];
        entries.push(candidate);
        byRarity.set(candidate.rarity, entries);
    }

    const configuredOdds = new Map((box.pullOdds || []).map(({ rarity, probability }) => [rarity, probability]));
    const weighted = Array.from(byRarity, ([rarity, items]) => ({
        rarity,
        items,
        weight: configuredOdds.has(rarity)
            ? configuredOdds.get(rarity)
            : items.reduce((total, item) => total + (item.dropRate || 0), 0) || 1,
    })).filter((entry) => entry.weight > 0);

    const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0);
    if (!totalWeight) return null;

    let roll = Math.random() * totalWeight;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll < 0) {
            return entry.items[Math.floor(Math.random() * entry.items.length)];
        }
    }
    return weighted[weighted.length - 1].items[0];
}

// Open one purchased pull  =>  /api/v1/blindbox/:productId/pull
exports.pullBlindBox = async (req, res, next) => {
    let reservedOrderId;
    let reservedProductId;
    let reservedItemId;

    try {
        const box = await Product.findById(req.params.productId);
        if (!box) return res.status(404).json({ success: false, message: 'Blind box not found.' });
        if (!box.isBlindBox) return res.status(400).json({ success: false, message: 'This product is not a blind box.' });
        if (!box.series) return res.status(400).json({ success: false, message: 'This blind box is missing its collectible series.' });

        // use up one purchased pull
        const reservedOrder = await Order.findOneAndUpdate(
            {
                user: req.user._id,
                orderStatus: { $ne: 'Cancelled' },
                orderItems: { $elemMatch: { product: box._id, pullsRemaining: { $gt: 0 } } },
            },
            { $inc: { 'orderItems.$.pullsRemaining': -1 } },
            { returnDocument: 'after' }
        );
        if (!reservedOrder) {
            return res.status(403).json({ success: false, message: 'Purchase this blind box before opening a pull.' });
        }
        reservedOrderId = reservedOrder._id;
        reservedProductId = box._id;

        const candidates = await Product.find({
            _id: { $ne: box._id },
            series: box.series,
            deletedAt: null,
            isBlindBox: false,
            stock: { $gt: 0 },
        }).select('_id name rarity dropRate');

        if (!candidates.length) {
            await Order.updateOne(
                { _id: reservedOrderId, 'orderItems.product': reservedProductId },
                { $inc: { 'orderItems.$.pullsRemaining': 1 } }
            );
            reservedOrderId = null;
            return res.status(409).json({ success: false, message: 'No in-stock collectibles are available for this series.' });
        }

        let selected;
        const remainingCandidates = [...candidates];
        while (remainingCandidates.length > 0) {
            const candidate = chooseWeightedRarity(box, remainingCandidates);
            if (!candidate) break;
            selected = await Product.findOneAndUpdate(
                { _id: candidate._id, stock: { $gt: 0 } },
                { $inc: { stock: -1 } },
                { returnDocument: 'after' }
            );
            if (selected) break;
            remainingCandidates.splice(remainingCandidates.findIndex((item) => item._id.equals(candidate._id)), 1);
        }

        if (!selected) {
            await Order.updateOne(
                { _id: reservedOrderId, 'orderItems.product': reservedProductId },
                { $inc: { 'orderItems.$.pullsRemaining': 1 } }
            );
            reservedOrderId = null;
            return res.status(409).json({ success: false, message: 'The available collectibles just changed. Please try again.' });
        }
        reservedItemId = selected._id;

        const pullLog = await PullLog.create({
            user: req.user._id,
            box: box._id,
            order: reservedOrderId,
            item: selected._id,
            rarity: selected.rarity,
        });
        reservedOrderId = null;
        reservedProductId = null;
        reservedItemId = null;

        return res.status(201).json({
            success: true,
            item: selected,
            pull: { id: pullLog._id, rarity: pullLog.rarity, createdAt: pullLog.createdAt },
        });
    } catch (error) {
        // give the pull and the stock back if anything failed half way
        if (reservedItemId) {
            await Product.updateOne({ _id: reservedItemId }, { $inc: { stock: 1 } });
        }
        if (reservedOrderId && reservedProductId) {
            await Order.updateOne(
                { _id: reservedOrderId, 'orderItems.product': reservedProductId },
                { $inc: { 'orderItems.$.pullsRemaining': 1 } }
            );
        }
        console.log(error)
        return res.status(500).json({ success: false, message: 'The pull could not be completed.' });
    }
}

// Everything the user has pulled so far  =>  /api/v1/blindbox/collection
exports.getMyCollection = async (req, res, next) => {
    const pulls = await PullLog.find({ user: req.user._id })
        .populate('item')
        .populate('box', 'name images series')
        .sort({ createdAt: -1 })
        .limit(100);
    return res.status(200).json({
        success: true,
        pulls
    })
}

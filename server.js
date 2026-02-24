const express = require('express');
const path = require('path');
const app = express();
const port = 3000;
const pool = require('./db');

app.use(express.json());
app.use(express.static('public')); // This serves your HTML/JS automatically

// The "Profit Engine" Logic
app.post('/api/calculate', (req, res) => {
    const { rate, miles, mpg, fuelPrice = 4.15 } = req.body;

    const fuelCost = (miles / mpg) * fuelPrice;
    const netRevenue = rate - fuelCost;
    const netPerMile = miles > 0 ? (netRevenue / miles) : 0;

    let rating, score, color;
    if (netPerMile >= 2.75) { rating = "Excellent"; score = 95; color = "#4ade80"; }
    else if (netPerMile >= 2.30) { rating = "Good"; score = 80; color = "#84cc16"; }
    else if (netPerMile >= 1.90) { rating = "Borderline"; score = 65; color = "#eab308"; }
    else { rating = "Bad Load"; score = 20; color = "#f87171"; }

    res.json({ fuelCost, netRevenue, netPerMile, rating, score, color });
});

// Save a load to the database
app.post('/api/save-load', async (req, res) => {
    const { rate, miles, fuelCost, netRevenue, netPerMile } = req.body;
    try {
        await pool.query(
            'INSERT INTO loads (rate, miles, fuel_cost, net_profit, net_per_mile) VALUES ($1, $2, $3, $4, $5)',
            [rate, miles, fuelCost, netRevenue, netPerMile]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`Engine running at http://localhost:${port}`));